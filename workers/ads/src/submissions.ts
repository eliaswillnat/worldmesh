/**
 * The advertiser's side: submit (upload + reserve + PaymentIntent), confirm
 * once Stripe.js says the card went through (checked with Stripe here, never
 * taken from the browser), cancel when the payment window is closed, and the
 * public list of what every billboard shows.
 */
import {
  AD_CONFIG,
  normalizeDestinationUrl,
  normalizeEmail,
  sanitizeAdvertiserName,
  type AdMediaType,
} from '../../../apps/hub/src/ads/config';
import { isBillboardId } from '../../../apps/hub/src/walk/layout';
import { hmacHex, isRandomId, randomId, sha256Hex, timingSafeEqual } from './crypto';
import { getAd, touch, transition, type AdRow } from './db';
import { now, type Env } from './env';
import { HttpError, isSameOrigin, json, readJson } from './http';
import { onAuthorized, releaseHold } from './lifecycle';
import { checkMedia, checkPoster } from './media';
import { createPaymentIntent, retrievePaymentIntent } from './stripe';

/** Multipart overhead allowance on top of the largest files. */
const FORM_OVERHEAD = 64 * 1024;

// ── Public billboard state ──────────────────────────────────────────────────

interface LiveRow {
  id: string;
  billboard_id: string;
  status: string;
  media_type: AdMediaType;
  poster_key: string | null;
  destination_url: string;
  advertiser_name: string;
  hold_expires_at: number | null;
  ends_at: number | null;
}

/** GET /api/ads/billboards — which screens show an ad, and which are held for one in review. */
export async function listBillboards(env: Env): Promise<Response> {
  const t = now(env);
  const { results } = await env.DB.prepare(
    `select id, billboard_id, status, media_type, poster_key, destination_url, advertiser_name, hold_expires_at, ends_at
     from ad_submission where status in ('awaiting_payment', 'pending', 'approved', 'active')`,
  ).all<LiveRow>();
  const billboards = [];
  for (const row of results) {
    if (row.status === 'active') {
      if (!row.ends_at || row.ends_at <= t) continue;
      billboards.push({
        id: row.billboard_id,
        state: 'active',
        ad: {
          id: row.id,
          type: row.media_type,
          mediaUrl: `/api/ads/media/${row.id}/media`,
          posterUrl: row.poster_key ? `/api/ads/media/${row.id}/poster` : null,
          url: row.destination_url,
          advertiser: row.advertiser_name,
        },
      });
    } else if (row.status !== 'awaiting_payment' || (row.hold_expires_at ?? 0) > t) {
      billboards.push({ id: row.billboard_id, state: 'reserved' });
    }
  }
  return json({ billboards }, 200, 'public, max-age=10');
}

// ── Submitting ──────────────────────────────────────────────────────────────

/** POST /api/ads/submissions (multipart/form-data). */
export async function createSubmission(request: Request, env: Env): Promise<Response> {
  if (!isSameOrigin(request, env)) throw new HttpError(403, 'Cross-site request refused.');
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.ADS_LIMITER && !(await env.ADS_LIMITER.limit({ key: `submit:${ip}` })).success) {
    throw new HttpError(429, 'Too many uploads. Please wait a minute and try again.');
  }
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) throw new HttpError(415, 'Expected a form upload.');
  const maxBody = AD_CONFIG.video.maxBytes + AD_CONFIG.poster.maxBytes + FORM_OVERHEAD;
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (!declared || declared > maxBody) throw new HttpError(413, 'The upload is too large.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'The upload could not be read.');
  }

  // Every field is checked here, whatever the form in the browser already did.
  const billboardId = form.get('billboardId');
  if (!isBillboardId(billboardId)) throw new HttpError(400, 'Unknown billboard.');
  const mediaType = form.get('mediaType');
  if (mediaType !== 'image' && mediaType !== 'video') throw new HttpError(400, 'Choose an image or a video.');
  const destination = normalizeDestinationUrl(form.get('destinationUrl'));
  if (!destination) throw new HttpError(400, 'The destination must be a plain https:// URL.');
  const advertiser = sanitizeAdvertiserName(form.get('advertiserName'));
  if (!advertiser) throw new HttpError(400, `Enter the advertiser name (up to ${AD_CONFIG.text.advertiserMaxLength} characters).`);
  const contact = normalizeEmail(form.get('contactEmail'));
  if (!contact) throw new HttpError(400, 'Enter a valid contact email.');
  if (form.get('consent') !== 'yes') throw new HttpError(400, 'Please confirm that you have the rights to this content.');
  const media = await checkMedia(form.get('media'), mediaType);
  const poster = mediaType === 'video' ? await checkPoster(form.get('poster')) : null;

  const t = now(env);
  const clientHash = (await hmacHex(env.ADS_SIGNING_SECRET, `client:${ip}`)).slice(0, 32);
  const open = await env.DB.prepare(
    "select count(*) as n from ad_submission where client_hash = ? and status = 'awaiting_payment' and hold_expires_at > ?",
  )
    .bind(clientHash, t)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= AD_CONFIG.maxOpenHoldsPerClient) {
    throw new HttpError(429, 'You already have billboards reserved for payment. Finish or close those first.');
  }

  // A hold on this billboard that ran out can be taken over; settle it first
  // (with Stripe, in case it was paid at the last moment).
  const stale = await env.DB.prepare(
    "select * from ad_submission where billboard_id = ? and status = 'awaiting_payment' and hold_expires_at <= ?",
  )
    .bind(billboardId, t)
    .all<AdRow>();
  for (const ad of stale.results) await releaseHold(env, ad, 'reservation_timeout');

  // Reserve: the partial unique index lets exactly one live row per billboard exist.
  const id = randomId();
  const token = randomId() + randomId();
  const mediaKey = `ads/${id}/${randomId()}.${media.ext}`;
  const posterKey = poster ? `ads/${id}/${randomId()}.${poster.ext}` : null;
  const holdExpiresAt = t + AD_CONFIG.reservationMs;
  try {
    await env.DB.prepare(
      `insert into ad_submission (id, billboard_id, status, media_type, media_mime, media_key, media_bytes, poster_key,
        advertiser_name, destination_url, contact_email, manage_token_hash, client_hash, amount_cents, currency,
        created_at, updated_at, hold_expires_at)
       values (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        billboardId,
        mediaType,
        media.mime,
        mediaKey,
        media.bytes.byteLength,
        posterKey,
        advertiser,
        destination,
        contact,
        await sha256Hex(token),
        clientHash,
        AD_CONFIG.priceCents,
        AD_CONFIG.currency,
        t,
        t,
        holdExpiresAt,
      )
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'This billboard has just been reserved by someone else. Please pick another empty one.');
    }
    throw error;
  }

  // Store the files under random names, then set up the €2 authorization.
  try {
    await env.ADS_MEDIA.put(mediaKey, media.bytes, { httpMetadata: { contentType: media.mime } });
    if (poster && posterKey) await env.ADS_MEDIA.put(posterKey, poster.bytes, { httpMetadata: { contentType: poster.mime } });
  } catch (error) {
    console.error('ads: upload to R2 failed', error);
    await abandon(env, id, 'upload_failed', [mediaKey, posterKey]);
    throw new HttpError(500, 'The upload could not be stored. Please try again.');
  }

  let clientSecret: string;
  try {
    const intent = await createPaymentIntent(env, {
      adId: id,
      billboardId,
      amount: AD_CONFIG.priceCents,
      currency: AD_CONFIG.currency,
      description: `WorldMesh billboard advertisement ${billboardId}`,
    });
    await touch(env, id, { stripe_payment_intent_id: intent.id, payment_status: intent.status });
    clientSecret = intent.client_secret;
  } catch (error) {
    console.error('ads: PaymentIntent creation failed', error);
    await abandon(env, id, 'payment_setup_failed', [mediaKey, posterKey]);
    throw new HttpError(502, 'Payments are unavailable right now. Nothing was charged; please try again later.');
  }

  return json({ id, token, clientSecret, publishableKey: env.STRIPE_PUBLISHABLE_KEY, holdExpiresAt }, 201);
}

async function abandon(env: Env, id: string, reason: string, keys: (string | null)[]): Promise<void> {
  await transition(env, id, ['awaiting_payment'], 'cancelled', { status_reason: reason, closed_at: now(env) }).catch(() => false);
  await env.ADS_MEDIA.delete(keys.filter((key): key is string => !!key)).catch(() => {});
  await touch(env, id, { media_deleted_at: now(env) }).catch(() => {});
}

/** The submission, if `token` is the one handed to the browser that created it. */
async function ownSubmission(request: Request, env: Env, id: string): Promise<AdRow> {
  const body = await readJson(request, 1024);
  const ad = isRandomId(id) ? await getAd(env, id) : null;
  if (!ad || typeof body.token !== 'string' || !timingSafeEqual(await sha256Hex(body.token), ad.manage_token_hash)) {
    throw new HttpError(404, 'Submission not found.');
  }
  return ad;
}

/**
 * POST /api/ads/submissions/:id/confirm { token } — Stripe.js reports the card
 * went through. Believe Stripe, not the browser: fetch the PaymentIntent.
 */
export async function confirmSubmission(request: Request, env: Env, id: string): Promise<Response> {
  if (!isSameOrigin(request, env)) throw new HttpError(403, 'Cross-site request refused.');
  let ad = await ownSubmission(request, env, id);
  if (ad.stripe_payment_intent_id && (ad.status === 'awaiting_payment' || ad.status === 'cancelled')) {
    const intent = await retrievePaymentIntent(env, ad.stripe_payment_intent_id);
    ad = await onAuthorized(env, ad, intent);
    if (ad.status === 'awaiting_payment') {
      return json({
        status: ad.status,
        message:
          intent.status === 'requires_action'
            ? 'Your bank still needs you to confirm the payment.'
            : (intent.last_payment_error?.message ?? 'The payment has not been authorized yet. You have not been charged.'),
      });
    }
  }
  if (ad.status === 'cancelled') {
    return json({
      status: ad.status,
      message: 'Your reservation ran out before the payment went through. Any authorization has been released; you have not been charged.',
    });
  }
  return json({ status: ad.status });
}

/** POST /api/ads/submissions/:id/cancel { token } — the payment window was closed. */
export async function cancelSubmission(request: Request, env: Env, id: string): Promise<Response> {
  if (!isSameOrigin(request, env)) throw new HttpError(403, 'Cross-site request refused.');
  const ad = await ownSubmission(request, env, id);
  const after = ad.status === 'awaiting_payment' ? await releaseHold(env, ad, 'abandoned') : ad;
  return json({ status: after.status });
}

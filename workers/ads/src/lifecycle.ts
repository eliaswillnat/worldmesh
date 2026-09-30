/**
 * Every way a submission moves between statuses, in one place. Each move is
 * a conditional update (see db.transition), so a webhook, the cron, the admin
 * and the advertiser's browser can all race for the same submission and only
 * one of them wins; the losers do nothing. Money only moves on Stripe's word
 * as read by this Worker, never on anything a browser reports.
 *
 *   awaiting_payment ─ authorized ─▶ pending ─ approve ─▶ approved ─ captured ─▶ active ─ run ends ─▶ expired
 *        │                            │  │                   │ └ capture refused ─▶ failed
 *        └ timeout / closed ─▶ cancelled  │                   └ capture unsure: stays until settled
 *                                     │  └ reject ─▶ rejected
 *                                     └ authorization lapses ─▶ expired
 */
import { AD_CONFIG, type AdStatus } from '../../../apps/hub/src/ads/config';
import { getAd, touch, transition, type AdRow } from './db';
import { advertiserNoticeFor, sendAdvertiserEmail, sendModerationEmail } from './email';
import { now, type Env } from './env';
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  captureBefore,
  retrievePaymentIntent,
  StripeApiError,
  type PaymentIntent,
} from './stripe';

const FINAL: AdStatus[] = ['rejected', 'expired', 'cancelled', 'failed'];
/** PaymentIntent states that still hold (or could still take) the customer's money. */
const OPEN_PAYMENT = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'];

export interface Outcome {
  ok: boolean;
  message: string;
}

/** Is this PaymentIntent really the one we created for this submission, for the right amount? */
export function belongsTo(ad: AdRow, intent: PaymentIntent): boolean {
  return (
    intent.id === ad.stripe_payment_intent_id &&
    intent.metadata?.ad_id === ad.id &&
    intent.amount === ad.amount_cents &&
    intent.currency === ad.currency &&
    intent.capture_method === 'manual'
  );
}

function paymentError(intent: PaymentIntent): string | null {
  const error = intent.last_payment_error;
  return error ? (error.message || error.code || 'Payment failed').slice(0, 300) : null;
}

// ── Notifications (each sent at most once) ─────────────────────────────────

async function claim(env: Env, id: string, column: 'admin_notified_at' | 'advertiser_notified_at'): Promise<boolean> {
  const result = await env.DB.prepare(`update ad_submission set ${column} = ? where id = ? and ${column} is null`).bind(now(env), id).run();
  return (result.meta.changes ?? 0) > 0;
}

async function unclaim(env: Env, id: string, column: 'admin_notified_at' | 'advertiser_notified_at'): Promise<void> {
  await env.DB.prepare(`update ad_submission set ${column} = null where id = ?`).bind(id).run();
}

export async function notifyAdmin(env: Env, id: string): Promise<void> {
  const ad = await getAd(env, id);
  if (!ad || ad.status !== 'pending' || !(await claim(env, id, 'admin_notified_at'))) return;
  // Unsent: let the cron try again.
  if (!(await sendModerationEmail(env, ad, now(env)))) await unclaim(env, id, 'admin_notified_at');
}

export async function notifyAdvertiser(env: Env, id: string): Promise<void> {
  const ad = await getAd(env, id);
  const notice = ad && advertiserNoticeFor(ad);
  if (!ad || !notice || !(await claim(env, id, 'advertiser_notified_at'))) return;
  if (!(await sendAdvertiserEmail(env, ad, notice))) await unclaim(env, id, 'advertiser_notified_at');
}

// ── Authorization ───────────────────────────────────────────────────────────

/**
 * Stripe reports the €2 authorized (requires_capture). If the billboard is
 * still held for this submission it goes to review; if the hold was already
 * released, the authorization is voided so the customer is never charged.
 */
export async function onAuthorized(env: Env, ad: AdRow, intent: PaymentIntent): Promise<AdRow> {
  if (!belongsTo(ad, intent) || intent.status !== 'requires_capture' || intent.amount_capturable < ad.amount_cents) return ad;
  const t = now(env);
  if (ad.status === 'awaiting_payment') {
    const lapses = captureBefore(intent) ?? intent.created * 1000 + AD_CONFIG.authorizationFallbackMs;
    const moved = await transition(env, ad.id, ['awaiting_payment'], 'pending', {
      authorized_at: t,
      authorization_expires_at: lapses - AD_CONFIG.authorizationSafetyMs,
      payment_status: intent.status,
      payment_error: null,
    });
    if (moved) await notifyAdmin(env, ad.id);
    return (await getAd(env, ad.id)) ?? ad;
  }
  if (FINAL.includes(ad.status)) {
    await cancelPaymentIntent(env, intent.id, 'abandoned');
    await touch(env, ad.id, {
      payment_status: 'canceled',
      ...(ad.status === 'cancelled' ? { status_reason: 'authorized_after_release' } : {}),
    });
    await notifyAdvertiser(env, ad.id);
    return (await getAd(env, ad.id)) ?? ad;
  }
  return ad;
}

/**
 * Let go of a billboard held for payment: the advertiser closed the window,
 * or the reservation ran out. Asks Stripe first, so an authorization that
 * slipped in at the last moment goes to review instead of being lost.
 */
export async function releaseHold(env: Env, ad: AdRow, reason: 'abandoned' | 'reservation_timeout'): Promise<AdRow> {
  if (ad.status !== 'awaiting_payment') return ad;
  let status: string | null = ad.payment_status;
  if (ad.stripe_payment_intent_id) {
    let intent = await retrievePaymentIntent(env, ad.stripe_payment_intent_id);
    if (intent.status === 'requires_capture') return onAuthorized(env, ad, intent);
    if (intent.status !== 'canceled' && intent.status !== 'succeeded') {
      try {
        intent = await cancelPaymentIntent(env, intent.id, 'abandoned');
      } catch (error) {
        // Confirmed between our two calls: it is authorized now.
        intent = await retrievePaymentIntent(env, ad.stripe_payment_intent_id);
        if (intent.status === 'requires_capture') return onAuthorized(env, ad, intent);
        throw error;
      }
    }
    status = intent.status;
  }
  await transition(env, ad.id, ['awaiting_payment'], 'cancelled', { status_reason: reason, closed_at: now(env), payment_status: status });
  return (await getAd(env, ad.id)) ?? ad;
}

// ── Moderation ──────────────────────────────────────────────────────────────

/** Admin approved: capture the €2, then put the advertisement up. */
export async function approve(env: Env, id: string, admin: string): Promise<Outcome> {
  const ad = await getAd(env, id);
  if (!ad || ad.status !== 'pending' || !ad.stripe_payment_intent_id) {
    return { ok: false, message: 'This advertisement is no longer waiting for review.' };
  }
  const claimed = await transition(env, id, ['pending'], 'approved', { reviewed_at: now(env), reviewed_by: admin });
  if (!claimed) return { ok: false, message: 'This advertisement is no longer waiting for review.' };

  let intent: PaymentIntent | null;
  try {
    intent = await capturePaymentIntent(env, ad.stripe_payment_intent_id, ad.id);
  } catch (error) {
    intent = error instanceof StripeApiError ? (error.paymentIntent ?? (await retrievePaymentIntent(env, ad.stripe_payment_intent_id).catch(() => null))) : null;
    if (!intent) {
      // We cannot tell whether the capture happened. The capture call is
      // idempotent and the cron settles "approved" rows with Stripe, so leave it.
      console.error('ads: capture outcome unknown', id, error);
      return { ok: false, message: 'Stripe could not be reached. The payment will be settled automatically within a few minutes.' };
    }
  }
  return settleApproved(env, id, intent);
}

/** An approved submission's capture has an outcome at Stripe: act on it. */
export async function settleApproved(env: Env, id: string, intent: PaymentIntent): Promise<Outcome> {
  const ad = await getAd(env, id);
  if (!ad || ad.status !== 'approved' || !belongsTo(ad, intent)) return { ok: false, message: 'Nothing to settle.' };
  const t = now(env);
  if (intent.status === 'succeeded') {
    const moved = await transition(env, id, ['approved'], 'active', {
      captured_at: t,
      activated_at: t,
      ends_at: t + AD_CONFIG.durationMs,
      payment_status: 'succeeded',
      payment_error: null,
    });
    if (moved) await notifyAdvertiser(env, id);
    return { ok: true, message: 'Approved. The payment was captured and the advertisement is live.' };
  }
  if (intent.status === 'requires_capture') {
    const error = paymentError(intent) ?? 'Stripe did not capture the payment.';
    await transition(env, id, ['approved'], 'pending', { payment_status: intent.status, payment_error: error });
    return { ok: false, message: `The capture did not go through (${error}). The advertisement is still waiting for review; you can try again.` };
  }
  if (intent.status === 'canceled') {
    const moved = await transition(env, id, ['approved'], 'failed', {
      status_reason: 'capture_failed',
      payment_status: 'canceled',
      payment_error: paymentError(intent) ?? 'The authorization was no longer valid.',
      closed_at: t,
    });
    if (moved) await notifyAdvertiser(env, id);
    return { ok: false, message: 'The card authorization had lapsed or was canceled, so nothing could be captured. Nothing was charged and the billboard is free again.' };
  }
  return { ok: false, message: `The payment is ${intent.status.replace(/_/g, ' ')}. It will be settled automatically.` };
}

/** Admin rejected: release the authorization, free the billboard, tell the advertiser. */
export async function reject(env: Env, id: string, admin: string, reason: string | null): Promise<Outcome> {
  const t = now(env);
  const moved = await transition(env, id, ['pending'], 'rejected', {
    status_reason: 'rejected',
    reviewed_at: t,
    reviewed_by: admin,
    reject_reason: reason,
    closed_at: t,
  });
  if (!moved) return { ok: false, message: 'This advertisement is no longer waiting for review.' };
  const ad = (await getAd(env, id))!;
  if (ad.stripe_payment_intent_id) {
    try {
      const intent = await cancelPaymentIntent(env, ad.stripe_payment_intent_id);
      await touch(env, id, { payment_status: intent.status });
    } catch (error) {
      // The cron keeps trying to release it (see sweep: unreleased authorizations).
      console.error('ads: release after reject failed', id, error);
    }
  }
  await notifyAdvertiser(env, id);
  return { ok: true, message: 'Rejected. The authorization was released; the advertiser was not charged.' };
}

/** Admin took a live advertisement down early. No automatic refund. */
export async function takeDown(env: Env, id: string, admin: string): Promise<Outcome> {
  const t = now(env);
  const moved = await transition(env, id, ['active'], 'expired', { status_reason: 'removed', reviewed_by: admin, closed_at: t, ends_at: t });
  return moved
    ? { ok: true, message: 'Taken down. The billboard is free again. Refund in the Stripe dashboard if appropriate.' }
    : { ok: false, message: 'This advertisement is not live.' };
}

// ── Stripe says so (webhook) ────────────────────────────────────────────────

export async function onPaymentIntentEvent(env: Env, type: string, intent: PaymentIntent, ad: AdRow): Promise<void> {
  if (!belongsTo(ad, intent)) return;
  switch (type) {
    case 'payment_intent.amount_capturable_updated':
      // Read it back from Stripe: events can arrive late or out of order, and
      // only the expanded charge carries the authorization's exact deadline.
      await onAuthorized(env, ad, await retrievePaymentIntent(env, intent.id));
      return;
    case 'payment_intent.payment_failed':
      // Declined: the advertiser can still try another card while the hold lasts.
      if (ad.status === 'awaiting_payment') await touch(env, ad.id, { payment_status: intent.status, payment_error: paymentError(intent) });
      return;
    case 'payment_intent.succeeded':
      if (ad.status === 'approved') await settleApproved(env, ad.id, intent);
      else await touch(env, ad.id, { payment_status: intent.status });
      return;
    case 'payment_intent.canceled':
      await onCanceled(env, ad, intent);
      return;
  }
}

/** The intent was canceled at Stripe: an authorization lapsed, or it was voided. */
export async function onCanceled(env: Env, ad: AdRow, intent: PaymentIntent): Promise<void> {
  const t = now(env);
  if (ad.status === 'awaiting_payment') {
    await transition(env, ad.id, ['awaiting_payment'], 'cancelled', { status_reason: 'payment_canceled', payment_status: 'canceled', closed_at: t });
  } else if (ad.status === 'pending') {
    const moved = await transition(env, ad.id, ['pending'], 'expired', { status_reason: 'authorization_expired', payment_status: 'canceled', closed_at: t });
    if (moved) await notifyAdvertiser(env, ad.id);
  } else if (ad.status === 'approved') {
    await settleApproved(env, ad.id, intent);
  } else {
    await touch(env, ad.id, { payment_status: 'canceled' });
  }
}

// ── Housekeeping (cron) ─────────────────────────────────────────────────────

const BATCH = 25;
const SETTLE_AFTER = 2 * 60 * 1000;

async function rows(env: Env, sql: string, ...values: unknown[]): Promise<AdRow[]> {
  return (await env.DB.prepare(sql).bind(...values).all<AdRow>()).results;
}

async function each(list: AdRow[], label: string, work: (ad: AdRow) => Promise<unknown>): Promise<void> {
  for (const ad of list) {
    try {
      await work(ad);
    } catch (error) {
      console.error(`ads: ${label} failed for ${ad.id}`, error);
    }
  }
}

export async function sweep(env: Env): Promise<void> {
  const t = now(env);

  // Unpaid reservations that ran out.
  await each(
    await rows(env, "select * from ad_submission where status = 'awaiting_payment' and hold_expires_at < ? limit ?", t, BATCH),
    'hold expiry',
    (ad) => releaseHold(env, ad, 'reservation_timeout'),
  );

  // Authorizations about to lapse before anyone reviewed them: release them first.
  await each(
    await rows(env, "select * from ad_submission where status = 'pending' and authorization_expires_at < ? limit ?", t, BATCH),
    'authorization expiry',
    async (ad) => {
      if (ad.stripe_payment_intent_id) await cancelPaymentIntent(env, ad.stripe_payment_intent_id, 'abandoned');
      const moved = await transition(env, ad.id, ['pending'], 'expired', {
        status_reason: 'authorization_expired',
        payment_status: 'canceled',
        closed_at: t,
      });
      if (moved) await notifyAdvertiser(env, ad.id);
    },
  );

  // Approvals whose capture outcome we never heard back about.
  await each(
    await rows(env, "select * from ad_submission where status = 'approved' and updated_at < ? limit ?", t - SETTLE_AFTER, BATCH),
    'capture settlement',
    async (ad) => settleApproved(env, ad.id, await retrievePaymentIntent(env, ad.stripe_payment_intent_id!)),
  );

  // Advertisements whose run is over.
  await env.DB.prepare(
    "update ad_submission set status = 'expired', status_reason = 'run_ended', closed_at = ?1, updated_at = ?1 where status = 'active' and ends_at < ?1",
  )
    .bind(t)
    .run();

  // Authorizations still open on submissions that are over (a release failed earlier).
  await each(
    await rows(
      env,
      `select * from ad_submission where status in ('rejected', 'expired', 'cancelled', 'failed')
       and stripe_payment_intent_id is not null and payment_status in (${OPEN_PAYMENT.map(() => '?').join(', ')}) limit ?`,
      ...OPEN_PAYMENT,
      BATCH,
    ),
    'release',
    async (ad) => {
      const intent = await cancelPaymentIntent(env, ad.stripe_payment_intent_id!, 'abandoned');
      await touch(env, ad.id, { payment_status: intent.status });
    },
  );

  // Emails that did not go out the first time.
  await each(
    await rows(env, "select * from ad_submission where status = 'pending' and admin_notified_at is null and authorized_at < ? limit ?", t - SETTLE_AFTER, BATCH),
    'admin email',
    (ad) => notifyAdmin(env, ad.id),
  );
  await each(
    await rows(
      env,
      `select * from ad_submission where advertiser_notified_at is null
       and status in ('active', 'rejected', 'failed', 'expired', 'cancelled') and updated_at between ? and ? limit ?`,
      t - 3 * 24 * 60 * 60 * 1000,
      t - SETTLE_AFTER,
      BATCH,
    ),
    'advertiser email',
    (ad) => (advertiserNoticeFor(ad) ? notifyAdvertiser(env, ad.id) : Promise.resolve()),
  );

  // Files of submissions that are over, after the retention period.
  await each(
    await rows(
      env,
      `select * from ad_submission where media_deleted_at is null and status in ('rejected', 'expired', 'cancelled', 'failed')
       and closed_at < case when status = 'cancelled' then ? else ? end limit ?`,
      t - AD_CONFIG.abandonedMediaRetentionMs,
      t - AD_CONFIG.mediaRetentionMs,
      BATCH,
    ),
    'media purge',
    async (ad) => {
      await env.ADS_MEDIA.delete([ad.media_key, ...(ad.poster_key ? [ad.poster_key] : [])]);
      await touch(env, ad.id, { media_deleted_at: t });
    },
  );

  await env.DB.prepare('delete from ad_stripe_event where received_at < ?').bind(t - 30 * 24 * 60 * 60 * 1000).run();
}

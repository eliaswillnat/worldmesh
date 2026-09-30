import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import { AD_CONFIG, normalizeDestinationUrl, sanitizeAdvertiserName } from '../../../apps/hub/src/ads/config';
import { billboardCatalog, isBillboardId, planCity } from '../../../apps/hub/src/walk/layout';
import worker, { type Env } from '../src/index';
import { hmacHex } from '../src/crypto';
import { sweep } from '../src/lifecycle';
import { imageSize, sniff } from '../src/media';
import { verifyWebhook } from '../src/stripe';

const ORIGIN = 'https://worldmesh.net';
const ADMIN = 'admin@worldmesh.test';
const WEBHOOK_SECRET = 'whsec_test_secret';
const MINUTE = 60_000;

let database: TestDatabase;
let env: Env;
let clock = Date.UTC(2026, 8, 30, 12);

// ── A small fake of the Stripe API and Resend ───────────────────────────────

interface FakeIntent {
  id: string;
  object: 'payment_intent';
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  capture_method: string;
  client_secret: string;
  created: number;
  metadata: Record<string, string>;
  latest_charge: unknown;
  last_payment_error: unknown;
}

const intents = new Map<string, FakeIntent>();
const emails: { to: string[]; subject: string; html: string }[] = [];
const stripeCalls: string[] = [];
let stripeDown = false;
const realFetch = globalThis.fetch;

function stripeError(status: number, code: string, message: string, intent?: FakeIntent): Response {
  return Response.json({ error: { code, message, payment_intent: intent } }, { status });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'api.resend.com') {
    emails.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `email_${emails.length}` });
  }
  if (url.hostname !== 'api.stripe.com') return realFetch(input, init);
  if (stripeDown) throw new TypeError('network down');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk_test_fake');
  const method = init?.method ?? 'GET';
  stripeCalls.push(`${method} ${url.pathname}`);
  const params = new URLSearchParams(String(init?.body ?? ''));
  if (method === 'POST' && url.pathname === '/v1/payment_intents') {
    const id = `pi_${intents.size + 1}`;
    const intent: FakeIntent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount: Number(params.get('amount')),
      amount_capturable: 0,
      amount_received: 0,
      currency: params.get('currency')!,
      capture_method: params.get('capture_method')!,
      client_secret: `${id}_secret_x`,
      created: Math.floor(clock / 1000),
      metadata: { ad_id: params.get('metadata[ad_id]')!, billboard_id: params.get('metadata[billboard_id]')! },
      latest_charge: null,
      last_payment_error: null,
    };
    intents.set(id, intent);
    return Response.json(intent);
  }
  const match = url.pathname.match(/^\/v1\/payment_intents\/(pi_\d+)(?:\/(capture|cancel))?$/);
  const intent = match && intents.get(match[1]);
  if (!intent) return stripeError(404, 'resource_missing', 'No such payment_intent');
  if (!match![2]) return Response.json(intent);
  if (match![2] === 'capture') {
    if (intent.status !== 'requires_capture') return stripeError(400, 'payment_intent_unexpected_state', 'Cannot capture', intent);
    Object.assign(intent, { status: 'succeeded', amount_capturable: 0, amount_received: intent.amount });
    return Response.json(intent);
  }
  if (intent.status === 'succeeded' || intent.status === 'canceled') {
    return stripeError(400, 'payment_intent_unexpected_state', 'Cannot cancel', intent);
  }
  Object.assign(intent, { status: 'canceled', amount_capturable: 0 });
  return Response.json(intent);
}

/** The customer's card goes through: what Stripe.js + the bank would do. */
function authorize(id: string): FakeIntent {
  const intent = intents.get(id)!;
  Object.assign(intent, {
    status: 'requires_capture',
    amount_capturable: intent.amount,
    latest_charge: { id: 'ch_1', payment_method_details: { card: { capture_before: Math.floor((clock + 7 * 24 * 60 * MINUTE) / 1000) } } },
  });
  return intent;
}

async function webhook(type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`): Promise<Response> {
  const payload = JSON.stringify({ id, type, created: Math.floor(clock / 1000), livemode: false, data: { object } });
  const t = Math.floor(clock / 1000);
  const signature = await hmacHex(WEBHOOK_SECRET, `${t}.${payload}`);
  return call('/api/ads/stripe/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${t},v1=${signature}`, 'Content-Type': 'application/json' },
    body: payload,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

/** A real (header-only) PNG of the given size: enough for sniffing and dimension checks. */
function png(width = 1080, height = 2160): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function mp4(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 0x20, ...new TextEncoder().encode('ftypisom')]);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 with height/width.
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff], 20);
  return bytes;
}

const FREE_BILLBOARDS = [...billboardCatalog().keys()];
let nextBillboard = 0;

interface SubmitOptions {
  billboardId?: string;
  file?: File;
  mediaType?: string;
  destinationUrl?: string;
  advertiserName?: string;
  consent?: string | null;
  origin?: string;
  ip?: string;
  poster?: File;
}

async function submit(options: SubmitOptions = {}): Promise<Response> {
  const form = new FormData();
  form.set('billboardId', options.billboardId ?? FREE_BILLBOARDS[nextBillboard++]);
  form.set('mediaType', options.mediaType ?? 'image');
  form.set('media', options.file ?? new File([png()], 'ad.png', { type: 'image/png' }));
  if (options.poster) form.set('poster', options.poster);
  form.set('destinationUrl', options.destinationUrl ?? 'https://example.com/shop');
  form.set('advertiserName', options.advertiserName ?? 'Acme Worlds');
  form.set('contactEmail', 'Owner@Example.com');
  if (options.consent !== null) form.set('consent', options.consent ?? 'yes');
  const body = new Request('https://x/', { method: 'POST', body: form });
  const bytes = await body.arrayBuffer();
  return call('/api/ads/submissions', {
    method: 'POST',
    headers: {
      'Content-Type': body.headers.get('Content-Type')!,
      'Content-Length': String(bytes.byteLength),
      Origin: options.origin ?? ORIGIN,
      'CF-Connecting-IP': options.ip ?? `10.0.0.${nextBillboard}`,
    },
    body: bytes,
  });
}

interface Created {
  id: string;
  token: string;
  clientSecret: string;
  publishableKey: string;
  holdExpiresAt: number;
}

async function created(options: SubmitOptions = {}): Promise<Created & { billboardId: string; paymentIntent: string }> {
  const billboardId = options.billboardId ?? FREE_BILLBOARDS[nextBillboard++];
  const response = await submit({ ...options, billboardId });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as Created;
  return { ...body, billboardId, paymentIntent: body.clientSecret.split('_secret')[0] };
}

async function row(id: string) {
  return (await env.DB.prepare('select * from ad_submission where id = ?').bind(id).first<Record<string, unknown>>())!;
}

async function pendingAd() {
  const ad = await created();
  const response = await webhook('payment_intent.amount_capturable_updated', authorize(ad.paymentIntent));
  expect(response.status).toBe(200);
  expect((await row(ad.id)).status).toBe('pending');
  return ad;
}

async function sessionCookie(email: string, verified = true): Promise<string> {
  const token = Math.random().toString(36).slice(2).padEnd(32, 'x');
  const iso = new Date(clock).toISOString();
  const address = verified ? email : `unverified.${email}`;
  let user = await env.DB.prepare('select id from "user" where email = ?').bind(address).first<{ id: string }>();
  if (!user) {
    user = { id: `u_${Math.random().toString(36).slice(2)}` };
    await env.DB.prepare('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?)')
      .bind(user.id, 'Someone', address, verified ? 1 : 0, iso, iso)
      .run();
  }
  await env.DB.prepare('insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values (?, ?, ?, ?, ?, ?)')
    .bind(`s_${token}`, new Date(clock + 30 * 24 * 60 * MINUTE).toISOString(), token, iso, iso, user.id)
    .run();
  return `__Secure-worldmesh.session_token=${encodeURIComponent(`${token}.c2lnbmF0dXJl`)}`;
}

async function adminAction(id: string, action: string, cookie: string, extra: Record<string, string> = {}): Promise<Response> {
  const page = await call(`/api/ads/admin/review?id=${id}`, { headers: { Cookie: cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1] ?? 'missing';
  return call('/api/ads/admin/review', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ id, action, csrf, ...extra }).toString(),
  });
}

async function billboards(): Promise<{ id: string; state: string; ad?: { id: string; url: string; mediaUrl: string } }[]> {
  return ((await (await call('/api/ads/billboards')).json()) as { billboards: never[] }).billboards;
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never, fileURLToPath(new URL('./wrangler.test.toml', import.meta.url)));
  env = {
    DB: database.db,
    ADS_MEDIA: database.env.ADS_MEDIA as R2Bucket,
    ADS_ORIGIN: ORIGIN,
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADS_SIGNING_SECRET: 'test-signing-secret-test-signing-secret',
    RESEND_API_KEY: 're_test',
    NOTIFICATION_EMAIL: ADMIN,
    ADMIN_EMAILS: ADMIN,
    NOW: () => clock,
  };
  vi.stubGlobal('fetch', fakeFetch);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await database?.dispose();
});

beforeEach(() => {
  emails.length = 0;
  stripeCalls.length = 0;
  stripeDown = false;
});

// ── Pure rules ──────────────────────────────────────────────────────────────

describe('billboard ids', () => {
  it('are permanent: the same towers and screens whatever the citadel size', () => {
    const small = planCity(19.28).flatMap((tower) => tower.screens.map((screen) => screen.id));
    const large = planCity(60).flatMap((tower) => tower.screens.map((screen) => screen.id));
    expect(small).toHaveLength(77);
    // Growing only adds towers; every existing screen keeps its id.
    expect(large.slice(0, small.length)).toEqual(small);
    expect(small.slice(0, 4)).toEqual(['f00-main', 'f00-wing', 'f01-main', 'f01-low']);
    for (const id of large) expect(billboardCatalog().has(id)).toBe(true);
  });

  it('only accepts ids that exist', () => {
    expect(isBillboardId('f01-main')).toBe(true);
    expect(isBillboardId('f01-wing')).toBe(false);
    expect(isBillboardId('f01-main; drop table')).toBe(false);
    expect(isBillboardId(7)).toBe(false);
  });
});

describe('input rules', () => {
  it('allows only plain https destinations', () => {
    expect(normalizeDestinationUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'http://example.com',
      'https://user:pass@example.com',
      'https://localhost/',
      'https://192.168.1.1/',
      ' java\tscript:alert(1)',
      'https://exa mple.com',
      `https://example.com/${'a'.repeat(2100)}`,
      'ftp://example.com',
      '//example.com',
    ]) {
      expect(normalizeDestinationUrl(bad), bad).toBeNull();
    }
  });

  it('cleans advertiser names', () => {
    expect(sanitizeAdvertiserName('  Acme   <b>Worlds</b>‮ ')).toBe('Acme bWorlds/b');
    expect(sanitizeAdvertiserName('​')).toBeNull();
    expect(sanitizeAdvertiserName('x'.repeat(81))).toBeNull();
  });

  it('recognises files by content and reads image sizes from headers', () => {
    expect(sniff(png())).toBe('image/png');
    expect(imageSize(png(640, 320), 'image/png')).toEqual({ width: 640, height: 320 });
    expect(sniff(jpeg(10, 20))).toBe('image/jpeg');
    expect(imageSize(jpeg(1200, 800), 'image/jpeg')).toEqual({ width: 1200, height: 800 });
    expect(sniff(mp4())).toBe('video/mp4');
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniff(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
  });
});

describe('stripe webhook signatures', () => {
  it('accepts only fresh deliveries signed with the endpoint secret', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    const t = Math.floor(clock / 1000);
    const good = `t=${t},v1=${await hmacHex(WEBHOOK_SECRET, `${t}.${payload}`)}`;
    expect(await verifyWebhook(payload, good, WEBHOOK_SECRET, clock)).not.toBeNull();
    expect(await verifyWebhook(payload.replace('evt_1', 'evt_2'), good, WEBHOOK_SECRET, clock)).toBeNull();
    expect(await verifyWebhook(payload, good, 'whsec_other', clock)).toBeNull();
    expect(await verifyWebhook(payload, good, WEBHOOK_SECRET, clock + 10 * MINUTE)).toBeNull();
    expect(await verifyWebhook(payload, null, WEBHOOK_SECRET, clock)).toBeNull();
  });

  it('rejects unsigned requests at the endpoint', async () => {
    const response = await call('/api/ads/stripe/webhook', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(response.status).toBe(400);
  });
});

// ── Submitting ──────────────────────────────────────────────────────────────

describe('submitting', () => {
  it('stores the upload privately, reserves the billboard and creates a manual-capture PaymentIntent', async () => {
    const ad = await created();
    expect(ad.publishableKey).toBe('pk_test_fake');
    const stored = await row(ad.id);
    expect(stored).toMatchObject({
      status: 'awaiting_payment',
      billboard_id: ad.billboardId,
      media_type: 'image',
      media_mime: 'image/png',
      destination_url: 'https://example.com/shop',
      advertiser_name: 'Acme Worlds',
      contact_email: 'owner@example.com',
      stripe_payment_intent_id: ad.paymentIntent,
      amount_cents: AD_CONFIG.priceCents,
      currency: 'eur',
    });
    expect(stored.media_key).toMatch(new RegExp(`^ads/${ad.id}/[a-z2-7]{26}\\.png$`));
    expect(stored.manage_token_hash).not.toContain(ad.token);
    expect(await env.ADS_MEDIA.head(String(stored.media_key))).not.toBeNull();
    expect(intents.get(ad.paymentIntent)).toMatchObject({ capture_method: 'manual', amount: 200, currency: 'eur' });

    expect(await billboards()).toContainEqual({ id: ad.billboardId, state: 'reserved' });
    // Not public while unreviewed.
    expect((await call(`/api/ads/media/${ad.id}/media`)).status).toBe(404);
  });

  it('lets only one person reserve a billboard, even at the same moment', async () => {
    const billboardId = FREE_BILLBOARDS[nextBillboard++];
    const results = await Promise.all([submit({ billboardId, ip: '1.1.1.1' }), submit({ billboardId, ip: '2.2.2.2' })]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('validates everything on the server', async () => {
    const cases: [SubmitOptions, number][] = [
      [{ destinationUrl: 'javascript:alert(1)' }, 400],
      [{ destinationUrl: 'data:text/html,hi' }, 400],
      [{ destinationUrl: 'file:///etc/passwd' }, 400],
      [{ destinationUrl: 'http://example.com' }, 400],
      [{ consent: null }, 400],
      [{ advertiserName: '   ' }, 400],
      [{ billboardId: 'zz99-main' }, 400],
      [{ file: new File([png()], 'ad.gif', { type: 'image/gif' }) }, 415],
      [{ file: new File(['<svg></svg>'.padEnd(64)], 'ad.png', { type: 'image/png' }) }, 415],
      [{ file: new File([png()], 'ad.png', { type: 'image/jpeg' }) }, 415],
      [{ file: new File([mp4()], 'ad.png', { type: 'image/png' }) }, 415],
      [{ file: new File([png(5000, 100)], 'ad.png', { type: 'image/png' }) }, 413],
      [{ file: new File([new Uint8Array(AD_CONFIG.image.maxBytes + 1).fill(1)], 'ad.png', { type: 'image/png' }) }, 413],
      [{ mediaType: 'video', file: new File([png()], 'ad.mp4', { type: 'video/mp4' }) }, 415],
      [{ origin: 'https://evil.example' }, 403],
    ];
    for (const [options, status] of cases) {
      const response = await submit(options);
      expect(response.status, JSON.stringify(options)).toBe(status);
    }
  });

  it('accepts a video with its still frame', async () => {
    const ad = await created({
      mediaType: 'video',
      file: new File([mp4()], 'clip.mp4', { type: 'video/mp4' }),
      poster: new File([jpeg(640, 1280)], 'poster.jpg', { type: 'image/jpeg' }),
    });
    const stored = await row(ad.id);
    expect(stored).toMatchObject({ media_type: 'video', media_mime: 'video/mp4' });
    expect(stored.poster_key).toMatch(/\.jpg$/);
  });

  it('confirms only what Stripe says, never what the browser says', async () => {
    const ad = await created();
    const confirm = () =>
      call(`/api/ads/submissions/${ad.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ token: ad.token, status: 'requires_capture' }),
      });
    expect(await (await confirm()).json()).toMatchObject({ status: 'awaiting_payment' });
    authorize(ad.paymentIntent);
    expect(await (await confirm()).json()).toMatchObject({ status: 'pending' });
    expect(emails.filter((email) => email.to[0] === ADMIN)).toHaveLength(1);

    // Someone else's token does nothing.
    const wrong = await call(`/api/ads/submissions/${ad.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ token: 'x'.repeat(52) }),
    });
    expect(wrong.status).toBe(404);
  });

  it('releases the billboard when the payment window is closed', async () => {
    const ad = await created();
    const response = await call(`/api/ads/submissions/${ad.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ token: ad.token }),
    });
    expect(await response.json()).toMatchObject({ status: 'cancelled' });
    expect(intents.get(ad.paymentIntent)!.status).toBe('canceled');
    expect((await billboards()).some((b) => b.id === ad.billboardId)).toBe(false);
    // Free for the next person.
    expect((await submit({ billboardId: ad.billboardId })).status).toBe(201);
  });

  it('keeps an authorization that arrives while the window is being closed', async () => {
    const ad = await created();
    authorize(ad.paymentIntent);
    const response = await call(`/api/ads/submissions/${ad.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ token: ad.token }),
    });
    expect(await response.json()).toMatchObject({ status: 'pending' });
  });

  it('lets a reservation run out, and the billboard be taken by someone else', async () => {
    const ad = await created();
    clock += AD_CONFIG.reservationMs + MINUTE;
    const next = await submit({ billboardId: ad.billboardId });
    expect(next.status).toBe(201);
    expect(await row(ad.id)).toMatchObject({ status: 'cancelled', status_reason: 'reservation_timeout' });
    expect(intents.get(ad.paymentIntent)!.status).toBe('canceled');

    // Paying after the hold was released is voided, never charged.
    const late = await created();
    clock += AD_CONFIG.reservationMs + MINUTE;
    await sweep(env);
    expect((await row(late.id)).status).toBe('cancelled');
    intents.get(late.paymentIntent)!.status = 'requires_payment_method';
    await webhook('payment_intent.amount_capturable_updated', authorize(late.paymentIntent));
    expect(intents.get(late.paymentIntent)!.status).toBe('canceled');
    expect(await row(late.id)).toMatchObject({ status: 'cancelled', status_reason: 'authorized_after_release' });
    expect(emails.some((email) => email.to[0] === 'owner@example.com' && /reservation ran out/i.test(email.subject))).toBe(true);
  });

  it('caps unpaid holds per client', async () => {
    const ip = '9.9.9.9';
    expect((await submit({ ip })).status).toBe(201);
    expect((await submit({ ip })).status).toBe(201);
    expect((await submit({ ip })).status).toBe(429);
  });
});

// ── Webhooks ────────────────────────────────────────────────────────────────

describe('webhooks', () => {
  it('moves an authorized submission to review once, however often Stripe repeats itself', async () => {
    const ad = await created();
    const intent = authorize(ad.paymentIntent);
    const first = await webhook('payment_intent.amount_capturable_updated', intent, 'evt_dup');
    const again = await webhook('payment_intent.amount_capturable_updated', intent, 'evt_dup');
    const other = await webhook('payment_intent.amount_capturable_updated', intent);
    expect(first.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(other.status).toBe(200);
    const stored = await row(ad.id);
    expect(stored.status).toBe('pending');
    expect(Number(stored.authorization_expires_at)).toBeLessThan(clock + 7 * 24 * 60 * MINUTE);
    const moderation = emails.filter((email) => email.to[0] === ADMIN);
    expect(moderation).toHaveLength(1);
    expect(moderation[0].html).toContain('Review Advertisement');
    expect(moderation[0].html).toContain(`/api/ads/admin/review?id=${ad.id}`);
    expect(moderation[0].html).toContain(ad.billboardId);
    expect(moderation[0].html).toMatch(/\/api\/ads\/media\/[a-z2-7]{26}\/media\?exp=\d+&amp;sig=[0-9a-f]{64}/);
  });

  it('ignores intents for a different amount, or not ours', async () => {
    const ad = await created();
    const intent = authorize(ad.paymentIntent);
    intent.amount = 1;
    await webhook('payment_intent.amount_capturable_updated', intent);
    expect((await row(ad.id)).status).toBe('awaiting_payment');
    intent.amount = 200;
    intent.metadata = { ...intent.metadata, ad_id: 'someoneelse' };
    await webhook('payment_intent.amount_capturable_updated', intent);
    expect((await row(ad.id)).status).toBe('awaiting_payment');
  });

  it('records failed payments and lets the advertiser retry', async () => {
    const ad = await created();
    await webhook('payment_intent.payment_failed', {
      ...intents.get(ad.paymentIntent),
      last_payment_error: { message: 'Your card was declined.' },
    });
    expect(await row(ad.id)).toMatchObject({ status: 'awaiting_payment', payment_error: 'Your card was declined.' });
    await webhook('payment_intent.amount_capturable_updated', authorize(ad.paymentIntent));
    expect((await row(ad.id)).status).toBe('pending');
  });

  it('expires a submission whose authorization Stripe cancels', async () => {
    const ad = await pendingAd();
    const intent = intents.get(ad.paymentIntent)!;
    intent.status = 'canceled';
    await webhook('payment_intent.canceled', intent);
    expect(await row(ad.id)).toMatchObject({ status: 'expired', status_reason: 'authorization_expired' });
    expect((await billboards()).some((b) => b.id === ad.billboardId)).toBe(false);
  });
});

// ── Moderation ──────────────────────────────────────────────────────────────

describe('moderation', () => {
  it('shows the review page only to signed-in admins', async () => {
    const ad = await pendingAd();
    const anonymous = await call(`/api/ads/admin/review?id=${ad.id}`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain('Acme Worlds');

    const stranger = await call(`/api/ads/admin/review?id=${ad.id}`, { headers: { Cookie: await sessionCookie('someone@example.com') } });
    expect(stranger.status).toBe(403);
    env.ADMIN_EMAILS = `${ADMIN},unverified.${ADMIN}`;
    const unverified = await call(`/api/ads/admin/review?id=${ad.id}`, { headers: { Cookie: await sessionCookie(ADMIN, false) } });
    env.ADMIN_EMAILS = ADMIN;
    expect(unverified.status).toBe(403);

    const admin = await call(`/api/ads/admin/review?id=${ad.id}`, { headers: { Cookie: await sessionCookie(ADMIN) } });
    expect(admin.status).toBe(200);
    const html = await admin.text();
    expect(html).toContain('Acme Worlds');
    expect(html).toContain('requires_capture');
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Reject<');
    expect(admin.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    // The admin can see the unreviewed file; nobody else can.
    expect((await call(`/api/ads/media/${ad.id}/media`, { headers: { Cookie: await sessionCookie(ADMIN) } })).status).toBe(200);
  });

  it('cannot be approved by anyone but an admin', async () => {
    const ad = await pendingAd();
    const cookie = await sessionCookie('advertiser@example.com');
    const forged = await call('/api/ads/admin/review', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: ad.id, action: 'approve', csrf: '0'.repeat(64) }).toString(),
    });
    expect(forged.status).toBe(403);
    const noCsrf = await call('/api/ads/admin/review', {
      method: 'POST',
      headers: { Cookie: await sessionCookie(ADMIN), Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: ad.id, action: 'approve', csrf: '0'.repeat(64) }).toString(),
    });
    expect(noCsrf.status).toBe(403);
    expect((await row(ad.id)).status).toBe('pending');
    expect(stripeCalls.some((c) => c.endsWith('/capture'))).toBe(false);
  });

  it('refuses cross-site admin form posts', async () => {
    const ad = await pendingAd();
    const cookie = await sessionCookie(ADMIN);
    const response = await call('/api/ads/admin/review', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
      body: new URLSearchParams({ id: ad.id, action: 'approve', csrf: 'x' }).toString(),
    });
    expect(response.status).toBe(403);
    expect((await row(ad.id)).status).toBe('pending');
  });

  it('approve: captures €2, puts the ad on the billboard and emails the advertiser', async () => {
    const ad = await pendingAd();
    const cookie = await sessionCookie(ADMIN);
    const response = await adminAction(ad.id, 'approve', cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('ok=1');
    expect(stripeCalls).toContain(`POST /v1/payment_intents/${ad.paymentIntent}/capture`);
    const stored = await row(ad.id);
    expect(stored).toMatchObject({ status: 'active', payment_status: 'succeeded', reviewed_by: ADMIN });
    expect(Number(stored.ends_at) - Number(stored.activated_at)).toBe(AD_CONFIG.durationMs);
    expect(emails.some((email) => email.to[0] === 'owner@example.com' && /is live/.test(email.subject))).toBe(true);

    const live = (await billboards()).find((b) => b.id === ad.billboardId)!;
    expect(live).toMatchObject({ state: 'active', ad: { id: ad.id, url: 'https://example.com/shop' } });
    const media = await call(live.ad!.mediaUrl);
    expect(media.status).toBe(200);
    expect(media.headers.get('Content-Type')).toBe('image/png');
    expect(media.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const range = await call(live.ad!.mediaUrl, { headers: { Range: 'bytes=0-7' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('Content-Range')).toBe('bytes 0-7/64');

    // A second approval (double click, replayed form) does nothing more.
    const again = await adminAction(ad.id, 'approve', cookie);
    expect(again.headers.get('Location')).toContain('ok=0');
    expect(stripeCalls.filter((c) => c.endsWith('/capture'))).toHaveLength(1);

    // The run ends by itself.
    clock += AD_CONFIG.durationMs + MINUTE;
    await sweep(env);
    expect(await row(ad.id)).toMatchObject({ status: 'expired', status_reason: 'run_ended' });
    expect((await billboards()).some((b) => b.id === ad.billboardId)).toBe(false);
    expect((await call(live.ad!.mediaUrl)).status).toBe(404);
  });

  it('reject: releases the authorization, frees the billboard and emails the advertiser', async () => {
    const ad = await pendingAd();
    const response = await adminAction(ad.id, 'reject', await sessionCookie(ADMIN), { reason: 'Misleading claims.' });
    expect(response.headers.get('Location')).toContain('ok=1');
    expect(intents.get(ad.paymentIntent)!.status).toBe('canceled');
    expect(intents.get(ad.paymentIntent)!.amount_received).toBe(0);
    expect(await row(ad.id)).toMatchObject({ status: 'rejected', reject_reason: 'Misleading claims.' });
    const mail = emails.find((email) => email.to[0] === 'owner@example.com')!;
    expect(mail.subject).toMatch(/not approved/);
    expect(mail.html).toContain('not</strong> been charged');
    expect((await submit({ billboardId: ad.billboardId })).status).toBe(201);
  });

  it('a failed capture charges nothing and frees the billboard', async () => {
    const ad = await pendingAd();
    intents.get(ad.paymentIntent)!.status = 'canceled';
    const response = await adminAction(ad.id, 'approve', await sessionCookie(ADMIN));
    expect(response.headers.get('Location')).toContain('ok=0');
    expect(await row(ad.id)).toMatchObject({ status: 'failed', status_reason: 'capture_failed' });
    expect(emails.some((email) => /could not be published/.test(email.subject))).toBe(true);
    expect((await billboards()).some((b) => b.id === ad.billboardId)).toBe(false);
  });

  it('an unknown capture outcome is settled later, never charged twice', async () => {
    const ad = await pendingAd();
    const cookie = await sessionCookie(ADMIN);
    const page = await (await call(`/api/ads/admin/review?id=${ad.id}`, { headers: { Cookie: cookie } })).text();
    const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)![1];
    stripeDown = true;
    const response = await call('/api/ads/admin/review', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: ad.id, action: 'approve', csrf }).toString(),
    });
    expect(response.headers.get('Location')).toContain('ok=0');
    expect((await row(ad.id)).status).toBe('approved');
    // Meanwhile the capture did happen at Stripe; the webhook settles it.
    stripeDown = false;
    const intent = intents.get(ad.paymentIntent)!;
    Object.assign(intent, { status: 'succeeded', amount_received: intent.amount });
    await webhook('payment_intent.succeeded', intent);
    expect((await row(ad.id)).status).toBe('active');
  });

  it('releases authorizations nobody reviewed in time', async () => {
    const ad = await pendingAd();
    clock += 7 * 24 * 60 * MINUTE;
    await sweep(env);
    expect(await row(ad.id)).toMatchObject({ status: 'expired', status_reason: 'authorization_expired' });
    expect(intents.get(ad.paymentIntent)!.status).toBe('canceled');
    expect(emails.some((email) => email.to[0] === 'owner@example.com' && /reviewed in time/.test(email.subject))).toBe(true);
  });

  it('lets the database refuse any status change outside the allowed moves', async () => {
    const ad = await pendingAd();
    await expect(env.DB.prepare("update ad_submission set status = 'active' where id = ?").bind(ad.id).run()).rejects.toThrow();
    await expect(env.DB.prepare("update ad_submission set status = 'awaiting_payment' where id = ?").bind(ad.id).run()).rejects.toThrow();
    expect((await row(ad.id)).status).toBe('pending');
  });

  it('serves unreviewed files only through signed links', async () => {
    const ad = await pendingAd();
    const moderation = emails.find((email) => email.to[0] === ADMIN)!;
    const signed = moderation.html.match(/https:\/\/worldmesh\.net(\/api\/ads\/media\/[^"]+)/)![1].replace(/&amp;/g, '&');
    expect((await call(signed)).status).toBe(200);
    expect((await call(signed.replace(/sig=[0-9a-f]/, 'sig=0'))).status).toBe(404);
    expect((await call(signed.replace(/exp=\d+/, 'exp=9999999999'))).status).toBe(404);
  });
});

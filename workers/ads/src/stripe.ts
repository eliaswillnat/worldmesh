/**
 * The handful of Stripe calls advertising needs, over Stripe's REST API with
 * plain fetch (no SDK in the Worker bundle), plus webhook signature checks.
 * The secret key never leaves this Worker.
 */
import { hmacHex, timingSafeEqual } from './crypto';
import type { Env } from './env';

const API = 'https://api.stripe.com/v1';
/** Pinned so response shapes do not shift under us when the account default changes. */
export const STRIPE_API_VERSION = '2024-06-20';
/** Reject webhook deliveries signed longer ago than this (replay protection). */
const WEBHOOK_TOLERANCE_S = 300;

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  status: PaymentIntentStatus;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  capture_method: string;
  client_secret: string;
  created: number;
  metadata: Record<string, string>;
  cancellation_reason?: string | null;
  last_payment_error?: { message?: string; code?: string; decline_code?: string } | null;
  latest_charge?: string | { id: string; payment_method_details?: { card?: { capture_before?: number } } } | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** Set when Stripe returns the PaymentIntent with the error (e.g. on capture). */
    readonly paymentIntent?: PaymentIntent,
  ) {
    super(message);
  }
}

/** application/x-www-form-urlencoded, with Stripe's bracket syntax for nesting. */
function encode(params: Record<string, string | number | string[] | Record<string, string>>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => out.append(`${key}[]`, item));
    else if (typeof value === 'object') for (const [sub, item] of Object.entries(value)) out.append(`${key}[${sub}]`, item);
    else out.append(key, String(value));
  }
  return out.toString();
}

async function call<T>(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number | string[] | Record<string, string>> = {},
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  const query = encode(params);
  let url = `${API}${path}`;
  let body: string | undefined;
  if (method === 'GET') {
    if (query) url += `?${query}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = query;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  const response = await fetch(url, { method, headers, body });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; payment_intent?: PaymentIntent };
  } & T;
  if (!response.ok) {
    const error = data.error ?? {};
    throw new StripeApiError(response.status, error.code, error.message || `Stripe responded ${response.status}`, error.payment_intent);
  }
  return data as T;
}

export interface NewPaymentIntent {
  adId: string;
  billboardId: string;
  amount: number;
  currency: string;
  description: string;
}

/**
 * €2, authorized now and captured only on approval (capture_method=manual).
 * Cards only: every card payment (including Apple Pay and Google Pay) supports
 * separate authorization and capture.
 */
export function createPaymentIntent(env: Env, intent: NewPaymentIntent): Promise<PaymentIntent> {
  return call<PaymentIntent>(
    env,
    'POST',
    '/payment_intents',
    {
      amount: intent.amount,
      currency: intent.currency,
      capture_method: 'manual',
      payment_method_types: ['card'],
      description: intent.description,
      metadata: { ad_id: intent.adId, billboard_id: intent.billboardId },
    },
    `ad-create:${intent.adId}`,
  );
}

export function retrievePaymentIntent(env: Env, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'GET', `/payment_intents/${encodeURIComponent(id)}`, { expand: ['latest_charge'] });
}

export function capturePaymentIntent(env: Env, id: string, adId: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(env, 'POST', `/payment_intents/${encodeURIComponent(id)}/capture`, { expand: ['latest_charge'] }, `ad-capture:${adId}`);
}

/**
 * Release an authorization (or void an unconfirmed intent). Already canceled
 * counts as success, so every caller can simply retry.
 */
export async function cancelPaymentIntent(
  env: Env,
  id: string,
  reason?: 'abandoned' | 'requested_by_customer',
): Promise<PaymentIntent> {
  try {
    return await call<PaymentIntent>(env, 'POST', `/payment_intents/${encodeURIComponent(id)}/cancel`, reason ? { cancellation_reason: reason } : {});
  } catch (error) {
    if (error instanceof StripeApiError && error.code === 'payment_intent_unexpected_state') {
      const current = await retrievePaymentIntent(env, id);
      if (current.status === 'canceled') return current;
    }
    throw error;
  }
}

/** When the card authorization lapses, per Stripe; null if it does not say. */
export function captureBefore(intent: PaymentIntent): number | null {
  const charge = intent.latest_charge;
  const seconds = charge && typeof charge === 'object' ? charge.payment_method_details?.card?.capture_before : undefined;
  return typeof seconds === 'number' ? seconds * 1000 : null;
}

/**
 * Verify a webhook delivery against the endpoint's signing secret
 * (Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">). Returns the event,
 * or null for anything forged, stale or malformed.
 */
export async function verifyWebhook(payload: string, header: string | null, secret: string, nowMs: number): Promise<StripeEvent | null> {
  if (!header || !secret) return null;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((item) => item?.trim());
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return null;
  if (Math.abs(nowMs / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return null;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) return null;
  try {
    const event = JSON.parse(payload) as StripeEvent;
    return typeof event?.id === 'string' && typeof event.type === 'string' && event.data?.object ? event : null;
  } catch {
    return null;
  }
}

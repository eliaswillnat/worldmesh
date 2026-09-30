/**
 * POST /api/ads/stripe/webhook. The only way Stripe tells us about payments
 * asynchronously. Every delivery's signature is verified against
 * STRIPE_WEBHOOK_SECRET before anything is read from it; redeliveries of an
 * event already handled are acknowledged and ignored.
 */
import { getAdByPaymentIntent } from './db';
import { now, type Env } from './env';
import { json, readText } from './http';
import { onCanceled, onPaymentIntentEvent } from './lifecycle';
import { retrievePaymentIntent, verifyWebhook, type PaymentIntent } from './stripe';

const HANDLED = new Set([
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'charge.expired',
]);

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await readText(request, 256 * 1024);
  const event = await verifyWebhook(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, now(env));
  if (!event) return json({ error: 'Invalid signature.' }, 400);
  if (!HANDLED.has(event.type)) return json({ received: true, ignored: true });

  const seen = await env.DB.prepare('select 1 from ad_stripe_event where id = ?').bind(event.id).first();
  if (seen) return json({ received: true, duplicate: true });

  const object = event.data.object;
  const intentId = event.type === 'charge.expired' ? (object.payment_intent as string | undefined) : (object.id as string | undefined);
  const ad = typeof intentId === 'string' ? await getAdByPaymentIntent(env, intentId) : null;
  if (ad) {
    if (event.type === 'charge.expired') {
      // The authorization lapsed; the intent itself tells us where it stands now.
      const intent = await retrievePaymentIntent(env, intentId!);
      if (intent.status === 'canceled') await onCanceled(env, ad, intent);
    } else {
      // Handlers only act on transitions that still make sense, so events
      // arriving out of order or twice are harmless.
      await onPaymentIntentEvent(env, event.type, object as unknown as PaymentIntent, ad);
    }
  }
  // Recorded only after handling: if handling threw, Stripe retries it.
  await env.DB.prepare('insert into ad_stripe_event (id, type, received_at) values (?, ?, ?) on conflict (id) do nothing')
    .bind(event.id, event.type, now(env))
    .run();
  return json({ received: true });
}

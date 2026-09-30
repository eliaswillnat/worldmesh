import type { AdMediaType, AdStatus } from '../../../apps/hub/src/ads/config';
import { now, type Env } from './env';

export interface AdRow {
  id: string;
  billboard_id: string;
  status: AdStatus;
  status_reason: string | null;
  media_type: AdMediaType;
  media_mime: string;
  media_key: string;
  media_bytes: number;
  poster_key: string | null;
  media_deleted_at: number | null;
  advertiser_name: string;
  destination_url: string;
  contact_email: string;
  manage_token_hash: string;
  client_hash: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  payment_status: string | null;
  payment_error: string | null;
  created_at: number;
  updated_at: number;
  hold_expires_at: number | null;
  authorized_at: number | null;
  authorization_expires_at: number | null;
  reviewed_at: number | null;
  reviewed_by: string | null;
  reject_reason: string | null;
  captured_at: number | null;
  activated_at: number | null;
  ends_at: number | null;
  closed_at: number | null;
  admin_notified_at: number | null;
  advertiser_notified_at: number | null;
}

export async function getAd(env: Env, id: string): Promise<AdRow | null> {
  return env.DB.prepare('select * from ad_submission where id = ?').bind(id).first<AdRow>();
}

export async function getAdByPaymentIntent(env: Env, paymentIntentId: string): Promise<AdRow | null> {
  return env.DB.prepare('select * from ad_submission where stripe_payment_intent_id = ?').bind(paymentIntentId).first<AdRow>();
}

/** Columns a transition may set alongside the status. Never user input. */
type Fields = Partial<Omit<AdRow, 'id' | 'status' | 'updated_at'>>;

/**
 * Move a submission from one of `from` to `to`, setting `fields`, in a single
 * conditional UPDATE. Returns false if it was no longer in `from`: someone (a
 * webhook, the cron, the admin) got there first, and the caller must not
 * repeat side effects like emails. The database trigger rejects any move not
 * in the allowed list, whatever the caller asks for.
 */
export async function transition(env: Env, id: string, from: AdStatus[], to: AdStatus, fields: Fields = {}): Promise<boolean> {
  const entries = Object.entries(fields);
  const sets = ['status = ?', 'updated_at = ?', ...entries.map(([column]) => `${column} = ?`)];
  const statement = env.DB.prepare(
    `update ad_submission set ${sets.join(', ')} where id = ? and status in (${from.map(() => '?').join(', ')})`,
  ).bind(to, now(env), ...entries.map(([, value]) => value ?? null), id, ...from);
  const result = await statement.run();
  return (result.meta.changes ?? 0) > 0;
}

/** Update bookkeeping columns without touching the status. */
export async function touch(env: Env, id: string, fields: Fields): Promise<void> {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  await env.DB.prepare(`update ad_submission set ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? where id = ?`)
    .bind(...entries.map(([, value]) => value ?? null), now(env), id)
    .run();
}

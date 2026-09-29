/**
 * Outgoing delivery. Every (activity, inbox) pair is a row in ap_delivery; a
 * run claims due rows, signs and POSTs each, and deletes it once delivered or
 * given up on. New activities are run right away through `waitUntil`, so the
 * request that created them is never slowed down; the cron retries the rest.
 *
 * Moving to Cloudflare Queues later means: `enqueue` also sends
 * { deliveryId } messages, and the queue consumer calls `deliverOne`.
 */
import { signingKey, type LocalActor } from './actors';
import { signRequest } from './crypto/signatures';
import { ownHost, uris, type Env } from './env';
import { ACTIVITY_JSON, safeFetch, UnsafeUrlError } from './net/safe-fetch';
import { userAgent } from './remote';

/** Minutes to wait after the Nth failed attempt. ~2 days in total, then give up. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440, 1440];
/** A claimed row is invisible to other runs for this long. */
const LEASE_MS = 5 * 60 * 1000;

export interface DeliveryRow {
  id: number;
  activity_id: string;
  inbox: string;
  attempts: number;
}

/** Creates delivery rows (deduplicated per inbox) for an activity. */
export function enqueueStatement(db: D1Database, activityId: string, inboxes: string[]): D1PreparedStatement[] {
  const now = Date.now();
  return [...new Set(inboxes)].map((inbox) =>
    db
      .prepare(
        `insert into ap_delivery (activity_id, inbox, next_attempt_at, created_at)
         values (?1, ?2, ?3, ?3) on conflict (activity_id, inbox) do nothing`,
      )
      .bind(activityId, inbox, now),
  );
}

/** Delivery rows for every distinct follower inbox of an actor, preferring shared inboxes. */
export function enqueueToFollowersStatement(db: D1Database, activityId: string, actorId: string): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `insert into ap_delivery (activity_id, inbox, next_attempt_at, created_at)
       select distinct ?1, coalesce(r.shared_inbox, r.inbox), ?2, ?2
       from ap_follower f join ap_remote_actor r on r.uri = f.follower_uri
       where f.actor_id = ?3
       on conflict (activity_id, inbox) do nothing`,
    )
    .bind(activityId, now, actorId);
}

export function batchSize(env: Env): number {
  const size = Number(env.DELIVERY_BATCH_SIZE ?? '8');
  return Number.isInteger(size) && size > 0 ? Math.min(size, 40) : 8;
}

/** Claims and delivers up to `limit` due rows, optionally only for one activity. */
export async function runDeliveries(env: Env, limit = batchSize(env), activityId?: string): Promise<number> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `update ap_delivery set attempts = attempts + 1, next_attempt_at = ?1
     where id in (
       select id from ap_delivery where next_attempt_at <= ?2 ${activityId ? 'and activity_id = ?4' : ''}
       order by next_attempt_at limit ?3
     )
     returning id, activity_id, inbox, attempts`,
  )
    .bind(...[now + LEASE_MS, now, limit, ...(activityId ? [activityId] : [])])
    .all<DeliveryRow>();

  for (const row of results) await deliverOne(env, row);
  return results.length;
}

export async function deliverOne(env: Env, row: DeliveryRow): Promise<void> {
  const activity = await env.DB.prepare(
    `select a.json, act.* from ap_activity a join ap_actor act on act.id = a.actor_id where a.id = ?`,
  )
    .bind(row.activity_id)
    .first<LocalActor & { json: string }>();
  if (!activity) {
    await env.DB.prepare('delete from ap_delivery where id = ?').bind(row.id).run();
    return;
  }

  let outcome: 'done' | 'retry' | 'drop';
  let error: string | null = null;
  try {
    const key = await signingKey(env, activity);
    const response = await safeFetch(row.inbox, {
      ownHost: ownHost(env),
      maxRedirects: 0,
      maxBytes: 64 * 1024,
      timeoutMs: 10_000,
      init: async (target) => ({
        method: 'POST',
        body: activity.json,
        headers: await signRequest({
          method: 'POST',
          url: target.toString(),
          headers: new Headers({ 'Content-Type': ACTIVITY_JSON, 'User-Agent': userAgent(env) }),
          body: activity.json,
          keyId: uris.key(env, activity.id),
          privateKey: key,
        }),
      }),
    });
    outcome = classify(response.status, row.attempts);
    if (outcome !== 'done') error = `HTTP ${response.status}`;
  } catch (caught) {
    error = String(caught).slice(0, 200);
    outcome = caught instanceof UnsafeUrlError ? 'drop' : 'retry';
  }

  if (outcome === 'retry' && row.attempts < BACKOFF_MINUTES.length) {
    const wait = BACKOFF_MINUTES[row.attempts - 1] * 60 * 1000;
    await env.DB.prepare('update ap_delivery set next_attempt_at = ?1, last_error = ?2 where id = ?3')
      .bind(Date.now() + wait, error, row.id)
      .run();
    return;
  }
  if (outcome !== 'done') console.warn('delivery dropped', row.inbox, error);
  await env.DB.prepare('delete from ap_delivery where id = ?').bind(row.id).run();
}

function classify(status: number, attempts: number): 'done' | 'retry' | 'drop' {
  if (status >= 200 && status < 300) return 'done';
  // 401/403 can mean the receiver could not fetch our key yet: retry a little.
  if (status === 401 || status === 403) return attempts < 3 ? 'retry' : 'drop';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'drop';
  return 'retry';
}

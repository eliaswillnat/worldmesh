/**
 * Public ActivityStreams documents: actors, their collections, and the
 * objects and activities we published.
 */
import { findCreatorByActorId, instanceDocument, personDocument } from './actors';
import { AS_CONTEXT, uris, type Env } from './env';
import { activityJson, errorResponse } from './http';

const PAGE_SIZE = 20;

export async function actorDocument(env: Env, actorId: string): Promise<Response> {
  const found = await findCreatorByActorId(env.DB, actorId);
  if (!found) return errorResponse(404, 'Not found.');
  if (found.actor.kind === 'application') return activityJson(instanceDocument(env, found.actor), 300);
  if (!found.creator) return errorResponse(404, 'Not found.');
  return activityJson(personDocument(env, found.actor, found.creator), 300);
}

/** Outbox: public Create activities, newest first, paged by `before` (ms). */
export async function outbox(env: Env, actorId: string, url: URL): Promise<Response> {
  if (!(await actorExists(env, actorId))) return errorResponse(404, 'Not found.');
  const id = uris.outbox(env, actorId);
  const total = await env.DB.prepare('select count(*) as n from ap_activity where actor_id = ? and public = 1')
    .bind(actorId)
    .first<{ n: number }>();

  if (!url.searchParams.has('page')) {
    return activityJson(
      { '@context': AS_CONTEXT, id, type: 'OrderedCollection', totalItems: total?.n ?? 0, first: `${id}?page=true` },
      60,
    );
  }

  const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(before)) return errorResponse(400, 'Bad cursor.');
  const { results } = await env.DB.prepare(
    `select json, published_at from ap_activity where actor_id = ? and public = 1 and published_at < ?
     order by published_at desc limit ?`,
  )
    .bind(actorId, before, PAGE_SIZE)
    .all<{ json: string; published_at: number }>();
  const items = results.map((row) => {
    const { '@context': _context, ...activity } = JSON.parse(row.json) as Record<string, unknown>;
    return activity;
  });
  const last = results[results.length - 1];
  return activityJson(
    {
      '@context': AS_CONTEXT,
      id: `${id}?page=true${url.searchParams.has('before') ? `&before=${before}` : ''}`,
      type: 'OrderedCollectionPage',
      partOf: id,
      orderedItems: items,
      ...(results.length === PAGE_SIZE && last ? { next: `${id}?page=true&before=${last.published_at}` } : {}),
    },
    60,
  );
}

/** Followers: the count is public; the list is not published. */
export async function followers(env: Env, actorId: string): Promise<Response> {
  if (!(await actorExists(env, actorId))) return errorResponse(404, 'Not found.');
  const total = await env.DB.prepare('select count(*) as n from ap_follower where actor_id = ?')
    .bind(actorId)
    .first<{ n: number }>();
  return activityJson(
    { '@context': AS_CONTEXT, id: uris.followers(env, actorId), type: 'OrderedCollection', totalItems: total?.n ?? 0 },
    300,
  );
}

/** Following: WorldMesh actors do not follow anyone yet. */
export async function following(env: Env, actorId: string): Promise<Response> {
  if (!(await actorExists(env, actorId))) return errorResponse(404, 'Not found.');
  return activityJson(
    {
      '@context': AS_CONTEXT,
      id: uris.following(env, actorId),
      type: 'OrderedCollection',
      totalItems: 0,
      orderedItems: [],
    },
    300,
  );
}

/** A GET on an inbox: what anyone may see of it is nothing. */
export async function emptyInbox(env: Env, actorId: string): Promise<Response> {
  if (!(await actorExists(env, actorId))) return errorResponse(404, 'Not found.');
  return activityJson({
    '@context': AS_CONTEXT,
    id: uris.inbox(env, actorId),
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: [],
  });
}

export async function objectDocument(env: Env, objectId: string): Promise<Response> {
  const row = await env.DB.prepare('select json from ap_object where id = ?').bind(objectId).first<{ json: string }>();
  return row ? activityJson(JSON.parse(row.json), 3600) : errorResponse(404, 'Not found.');
}

export async function activityDocument(env: Env, activityId: string): Promise<Response> {
  const row = await env.DB.prepare('select json from ap_activity where id = ? and public = 1')
    .bind(activityId)
    .first<{ json: string }>();
  return row ? activityJson(JSON.parse(row.json), 3600) : errorResponse(404, 'Not found.');
}

async function actorExists(env: Env, actorId: string): Promise<boolean> {
  return !!(await env.DB.prepare('select 1 from ap_actor where id = ?').bind(actorId).first());
}

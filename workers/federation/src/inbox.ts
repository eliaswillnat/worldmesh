/**
 * The inbox: the one endpoint where the open internet writes to us. Every
 * request is treated as hostile until proven otherwise:
 *
 *   size cap → content type → JSON shape → HTTP signature (fetching the key
 *   through the SSRF guard) → signer is the activity's actor → activity id on
 *   the actor's host → de-duplication → idempotent side effects.
 *
 * Payloads are handled as plain JSON: no JSON-LD expansion, no remote
 * contexts, and nothing is dereferenced beyond the signer's own key.
 */
import { AS_CONTEXT, localId, ownHost, randomId, uris, type Env } from './env';
import { enqueueStatement, runDeliveries } from './delivery';
import { verifyRequest } from './crypto/signatures';
import { HttpError, readBody } from './http';
import { isActivityJson, parseJsonObject } from './net/safe-fetch';
import { getRemoteActor, keyResolver, sameHost } from './remote';

const MAX_INBOX_BYTES = 256 * 1024;
type Activity = Record<string, unknown>;

export async function handleInbox(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  targetActorId: string | null,
): Promise<Response> {
  if (!isActivityJson(request.headers.get('Content-Type')) && !/^application\/json\b/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new HttpError(415, 'Expected application/activity+json.');
  }
  if (env.INBOX_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await env.INBOX_LIMITER.limit({ key: ip })).success) throw new HttpError(429, 'Slow down.');
  }
  if (targetActorId) {
    const exists = await env.DB.prepare('select 1 from ap_actor where id = ?').bind(targetActorId).first();
    if (!exists) throw new HttpError(404, 'No such actor.');
  }

  const body = await readBody(request, MAX_INBOX_BYTES);
  const activity = parseJsonObject(body);
  if (!activity) throw new HttpError(400, 'Expected a JSON object.');
  const id = idOf(activity);
  const type = typeof activity.type === 'string' ? activity.type : null;
  const actor = idOf(activity.actor);
  if (!id || !type || !actor || !isHttps(id) || !isHttps(actor)) throw new HttpError(400, 'Not an activity.');

  // Account deletions are broadcast to every server that ever saw the actor,
  // and the actor (and its key) is already gone. Unless they follow someone
  // here, there is nothing to clean up and nothing worth a fetch.
  if (type === 'Delete' && idOf(activity.object) === actor) {
    const known = await env.DB.prepare('select 1 from ap_remote_actor where uri = ?').bind(actor).first();
    if (!known) return accepted();
  }

  const verified = await verifyRequest(request, body, ownHost(env), keyResolver(env));
  if (!verified.ok) {
    console.warn('inbox signature rejected', verified.reason, actor);
    throw new HttpError(401, `Signature rejected: ${verified.reason}.`);
  }
  // Only first-hand activities: the signer must be the actor. (Forwarded
  // activities would need LD signatures or a refetch; not supported yet.)
  if (verified.owner !== actor) throw new HttpError(401, 'Signer is not the actor.');
  if (!sameHost(id, actor)) throw new HttpError(400, 'Activity id is not on the actor’s host.');

  const seen = await env.DB.prepare(
    'insert into ap_inbox_seen (activity_id, actor_uri, type, received_at) values (?1, ?2, ?3, ?4) on conflict do nothing',
  )
    .bind(id, actor, type.slice(0, 32), Date.now())
    .run();
  if (!seen.meta.changes) return accepted();

  try {
    await dispatch(env, ctx, activity, type, actor);
  } catch (error) {
    // Let the sender retry: forget we saw it.
    await env.DB.prepare('delete from ap_inbox_seen where activity_id = ?').bind(id).run();
    throw error;
  }
  return accepted();
}

async function dispatch(env: Env, ctx: ExecutionContext, activity: Activity, type: string, actor: string) {
  switch (type) {
    case 'Follow':
      return onFollow(env, ctx, activity, actor);
    case 'Undo':
      return onUndo(env, activity, actor);
    case 'Like':
    case 'Announce':
      return onInteraction(env, activity, type, actor);
    case 'Create':
      return onCreate(env, activity, actor);
    case 'Delete':
      return onDelete(env, activity, actor);
    case 'Update':
      return onUpdate(env, activity, actor);
    default:
      // Accept, Reject, Block, Flag, Move, …: acknowledged, not acted on yet.
      return;
  }
}

async function onFollow(env: Env, ctx: ExecutionContext, follow: Activity, follower: string) {
  const targetId = localId(env, 'actors', idOf(follow.object));
  if (!targetId) return;
  const target = await env.DB.prepare("select id from ap_actor where id = ? and kind != 'application'")
    .bind(targetId)
    .first<{ id: string }>();
  if (!target) return;

  // The signature check cached the follower; getRemoteActor reads that cache.
  const remote = await getRemoteActor(env, follower);
  if (!remote) return;

  const followId = idOf(follow) as string;
  const acceptId = randomId();
  const accept = {
    '@context': AS_CONTEXT,
    id: uris.activity(env, acceptId),
    type: 'Accept',
    actor: uris.actor(env, target.id),
    object: { id: followId, type: 'Follow', actor: follower, object: uris.actor(env, target.id) },
  };
  await env.DB.batch([
    env.DB.prepare(
      `insert into ap_follower (actor_id, follower_uri, follow_activity_id, created_at) values (?1, ?2, ?3, ?4)
       on conflict (actor_id, follower_uri) do update set follow_activity_id = ?3`,
    ).bind(target.id, follower, followId, Date.now()),
    env.DB.prepare(
      'insert into ap_activity (id, actor_id, type, public, json, published_at) values (?1, ?2, ?3, 0, ?4, ?5)',
    ).bind(acceptId, target.id, 'Accept', JSON.stringify(accept), Date.now()),
    // An Accept goes to the follower's own inbox, not the shared one.
    ...enqueueStatement(env.DB, acceptId, [remote.inbox]),
  ]);
  ctx.waitUntil(runDeliveries(env, 1, acceptId).catch((error) => console.error('accept delivery', error)));
}

async function onUndo(env: Env, undo: Activity, actor: string) {
  const inner = undo.object;
  const innerId = idOf(inner);
  if (!innerId) return;
  const innerObject = inner && typeof inner === 'object' ? (inner as Activity) : null;
  // An embedded activity must be the undoer's own.
  if (innerObject && idOf(innerObject.actor) && idOf(innerObject.actor) !== actor) return;
  const innerType = innerObject && typeof innerObject.type === 'string' ? innerObject.type : null;

  if (!innerType || innerType === 'Follow') {
    const targetId = localId(env, 'actors', innerObject ? idOf(innerObject.object) : null);
    await env.DB.prepare(
      targetId
        ? 'delete from ap_follower where follower_uri = ?1 and (follow_activity_id = ?2 or actor_id = ?3)'
        : 'delete from ap_follower where follower_uri = ?1 and follow_activity_id = ?2',
    )
      .bind(...[actor, innerId, ...(targetId ? [targetId] : [])])
      .run();
  }
  if (!innerType || innerType === 'Like' || innerType === 'Announce') {
    await env.DB.prepare('delete from ap_interaction where activity_id = ? and actor_uri = ?').bind(innerId, actor).run();
  }
}

async function onInteraction(env: Env, activity: Activity, type: 'Like' | 'Announce', actor: string) {
  const objectId = localId(env, 'objects', idOf(activity.object));
  if (!objectId) return;
  await recordInteraction(env, idOf(activity) as string, objectId, actor, type);
}

async function onCreate(env: Env, create: Activity, actor: string) {
  const object = create.object;
  if (!object || typeof object !== 'object') return;
  const note = object as Activity;
  const replyTo = localId(env, 'objects', idOf(note.inReplyTo));
  const noteId = idOf(note);
  if (!replyTo || !noteId || !sameHost(noteId, actor)) return;
  if (idOf(note.attributedTo) && idOf(note.attributedTo) !== actor) return;
  // Only the reference is kept; the reply's content stays on its own server.
  await recordInteraction(env, noteId, replyTo, actor, 'Reply');
}

async function onDelete(env: Env, activity: Activity, actor: string) {
  const objectId = idOf(activity.object);
  if (!objectId) return;
  if (objectId === actor) {
    // The account is gone: drop everything we keep about it.
    await env.DB.batch([
      env.DB.prepare('delete from ap_interaction where actor_uri = ?').bind(actor),
      env.DB.prepare('delete from ap_remote_actor where uri = ?').bind(actor), // cascades to ap_follower
    ]);
    return;
  }
  await env.DB.prepare('delete from ap_interaction where activity_id = ? and actor_uri = ?').bind(objectId, actor).run();
}

async function onUpdate(env: Env, activity: Activity, actor: string) {
  // A profile update may carry a new key: make the next signature refetch it.
  if (idOf(activity.object) === actor) {
    await env.DB.prepare('update ap_remote_actor set fetched_at = 0 where uri = ?').bind(actor).run();
  }
}

async function recordInteraction(env: Env, activityId: string, objectId: string, actor: string, type: string) {
  await env.DB.prepare(
    `insert into ap_interaction (activity_id, object_id, actor_uri, type, created_at)
     select ?1, id, ?3, ?4, ?5 from ap_object where id = ?2
     on conflict (activity_id) do nothing`,
  )
    .bind(activityId, objectId, actor, type, Date.now())
    .run();
}

/** The id of an ActivityStreams reference: a URI string, or an object with an id. */
export function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length <= 2048 ? value : null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Activity).id;
    return typeof id === 'string' && id.length <= 2048 ? id : null;
  }
  return null;
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

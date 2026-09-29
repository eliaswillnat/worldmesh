/**
 * WorldMesh federation: WebFinger + ActivityPub for WorldMesh creators.
 *
 * A separate Worker from accounts (workers/auth) on purpose. It reads the
 * canonical WorldMesh data in D1 and adds only what federation needs on top.
 * Nothing here is on the path of an ordinary hub page load, and the 3D worlds
 * and @worldmesh/runtime know nothing about it.
 */
import { activityDocument, actorDocument, emptyInbox, followers, following, objectDocument, outbox } from './documents';
import { batchSize, runDeliveries } from './delivery';
import { hostMeta, nodeinfo, nodeinfoLinks, webfinger } from './discovery';
import { origin, type Env } from './env';
import { cached, errorResponse, HttpError, jsonResponse, readBody } from './http';
import { handleInbox } from './inbox';
import { profilePage, worldPage } from './pages';
import { announceWorld } from './publish';
import { timingSafeEqual } from './crypto/keys';

export type { Env };

const ID = '([a-z0-9-]{1,64})';
const ACTOR = new RegExp(`^/ap/actors/${ID}$`);
const ACTOR_COLLECTION = new RegExp(`^/ap/actors/${ID}/(inbox|outbox|followers|following)$`);
const OBJECT = new RegExp(`^/ap/objects/${ID}$`);
const ACTIVITY = new RegExp(`^/ap/activities/${ID}$`);
const PROFILE = /^\/@([A-Za-z0-9_]{1,30})\/?$/;
const WORLD_PAGE = /^\/@([A-Za-z0-9_]{1,30})\/worlds\/([A-Za-z0-9_-]{1,100})\/?$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      console.error('federation error', error);
      return errorResponse(500, 'Something went wrong.');
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(housekeeping(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  if (method === 'POST') {
    if (path === '/ap/inbox') return handleInbox(request, env, ctx, null);
    const inbox = path.match(ACTOR_COLLECTION);
    if (inbox && inbox[2] === 'inbox') return handleInbox(request, env, ctx, inbox[1]);
    if (path === '/ap/admin/announce') return adminAnnounce(request, env, ctx);
    throw new HttpError(405, 'Method not allowed.');
  }
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');

  if (path === '/.well-known/webfinger') return cached(request, ctx, () => webfinger(request, env));
  if (path === '/.well-known/host-meta') return hostMeta(env);
  if (path === '/.well-known/nodeinfo') return nodeinfoLinks(env);
  if (path === '/nodeinfo/2.1') return cached(request, ctx, () => nodeinfo(env));
  if (path === '/ap/inbox') return jsonResponse({ error: 'POST activities here.' }, 405);

  let match: RegExpMatchArray | null;
  if ((match = path.match(ACTOR))) {
    const actorId = match[1];
    return cached(request, ctx, () => actorDocument(env, actorId));
  }
  if ((match = path.match(ACTOR_COLLECTION))) {
    const [, actorId, collection] = match;
    if (collection === 'inbox') return emptyInbox(env, actorId);
    if (collection === 'followers') return cached(request, ctx, () => followers(env, actorId));
    if (collection === 'following') return cached(request, ctx, () => following(env, actorId));
    return cached(request, ctx, () => outbox(env, actorId, url));
  }
  if ((match = path.match(OBJECT))) {
    const objectId = match[1];
    return cached(request, ctx, () => objectDocument(env, objectId));
  }
  if ((match = path.match(ACTIVITY))) {
    const activityId = match[1];
    return cached(request, ctx, () => activityDocument(env, activityId));
  }
  if ((match = path.match(WORLD_PAGE))) {
    const [, username, worldId] = match;
    return cached(request, ctx, () => worldPage(request, env, username, worldId));
  }
  if ((match = path.match(PROFILE))) {
    const username = match[1];
    return cached(request, ctx, () => profilePage(request, env, username));
  }
  throw new HttpError(404, 'Not found.');
}

/**
 * POST /ap/admin/announce { "worldId": "..." } with
 * `Authorization: Bearer <FEDERATION_ADMIN_TOKEN>`. Announces one published,
 * owned world to its creator's followers. Idempotent.
 */
async function adminAnnounce(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = env.FEDERATION_ADMIN_TOKEN;
  const presented = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token || token.length < 16 || !(await timingSafeEqual(presented, token))) {
    throw new HttpError(401, 'Unauthorized.');
  }
  let worldId: unknown;
  try {
    worldId = (JSON.parse(new TextDecoder().decode(await readBody(request, 1024))) as { worldId?: unknown }).worldId;
  } catch {
    throw new HttpError(400, 'Expected {"worldId": "..."}.');
  }
  if (typeof worldId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(worldId)) throw new HttpError(400, 'Bad worldId.');

  const result = await announceWorld(env, worldId);
  if (!result.ok) throw new HttpError(result.status, result.error);
  if (result.deliveries > 0) {
    ctx.waitUntil(runDeliveries(env, batchSize(env), result.activityId).catch((e) => console.error('delivery', e)));
  }
  return jsonResponse({ ...result, object: `${origin(env)}/ap/objects/${result.objectId}` });
}

async function housekeeping(env: Env, scheduledTime: number): Promise<void> {
  await runDeliveries(env);
  // Once an hour: forget old inbox ids and remote actors nobody here relates to.
  if (new Date(scheduledTime).getUTCMinutes() < 5) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('delete from ap_inbox_seen where received_at < ?').bind(now - 14 * 86_400_000),
      env.DB.prepare(
        `delete from ap_remote_actor where fetched_at < ?
         and uri not in (select follower_uri from ap_follower)
         and uri not in (select actor_uri from ap_interaction)`,
      ).bind(now - 30 * 86_400_000),
    ]);
  }
}

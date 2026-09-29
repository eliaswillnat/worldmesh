/**
 * Discovery: WebFinger (RFC 7033) for @username@domain lookups, host-meta for
 * older software, and NodeInfo so other servers can tell what WorldMesh is.
 */
import { ensureInstanceActor, ensurePersonActor, findCreatorByUsername, INSTANCE_ACTOR_ID } from './actors';
import { origin, uris, type Env } from './env';
import { errorResponse, jsonResponse } from './http';

/** GET /.well-known/webfinger?resource=acct:elias@worldmesh.net */
export async function webfinger(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const resources = params.getAll('resource');
  if (resources.length !== 1 || resources[0].length > 512) return errorResponse(400, 'Exactly one resource is required.');
  const username = usernameFromResource(env, resources[0]);
  if (username === null) return errorResponse(404, 'Not found.');

  if (username === env.FEDERATION_DOMAIN.toLowerCase()) {
    const instance = await ensureInstanceActor(env);
    return jrd(env, env.FEDERATION_DOMAIN, uris.actor(env, instance.id), `${origin(env)}/`);
  }

  const creator = await findCreatorByUsername(env.DB, username);
  if (!creator) return errorResponse(404, 'Not found.');
  const actor = await ensurePersonActor(env, creator.user_id);
  return jrd(env, creator.username, uris.actor(env, actor.id), uris.profile(env, creator.username));
}

/**
 * Accepts acct:user@domain (optionally with a leading @), and our own actor
 * and profile URLs. Returns the lowercase username, or null.
 */
export function usernameFromResource(env: Env, resource: string): string | null {
  const domain = env.FEDERATION_DOMAIN.toLowerCase();
  const acct = resource.match(/^acct:@?([^@\s]+)@([^@\s]+)$/i);
  if (acct) return acct[2].toLowerCase() === domain ? acct[1].toLowerCase() : null;

  const profilePrefix = `${origin(env)}/@`;
  if (resource.startsWith(profilePrefix)) {
    const name = resource.slice(profilePrefix.length).toLowerCase();
    return /^[a-z][a-z0-9_]{2,29}$/.test(name) ? name : null;
  }
  // Actor URLs resolve through the actor itself; WebFinger by actor URL is rare.
  if (resource === uris.actor(env, INSTANCE_ACTOR_ID)) return domain;
  return null;
}

function jrd(env: Env, username: string, actorUri: string, profileUrl: string): Response {
  return jsonResponse(
    {
      subject: `acct:${username}@${env.FEDERATION_DOMAIN}`,
      aliases: [profileUrl, actorUri],
      links: [
        { rel: 'self', type: 'application/activity+json', href: actorUri },
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: profileUrl },
      ],
    },
    200,
    'application/jrd+json',
    300,
  );
}

/** GET /.well-known/host-meta — the XRD pointer to WebFinger that some older servers still ask for. */
export function hostMeta(env: Env): Response {
  const template = `${origin(env)}/.well-known/webfinger?resource={uri}`;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n  <Link rel="lrdd" template="${template}"/>\n</XRD>\n`,
    {
      headers: {
        'Content-Type': 'application/xrd+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      },
    },
  );
}

/** GET /.well-known/nodeinfo */
export function nodeinfoLinks(env: Env): Response {
  return jsonResponse(
    { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${origin(env)}/nodeinfo/2.1` }] },
    200,
    'application/json',
    86400,
  );
}

/** GET /nodeinfo/2.1 */
export async function nodeinfo(env: Env): Promise<Response> {
  const row = await env.DB.prepare("select count(*) as n from ap_actor where kind = 'person'").first<{ n: number }>();
  const posts = await env.DB.prepare("select count(*) as n from ap_object").first<{ n: number }>();
  return jsonResponse(
    {
      version: '2.1',
      software: { name: 'worldmesh', version: '0.1.0', homepage: `${origin(env)}/` },
      protocols: ['activitypub'],
      services: { inbound: [], outbound: [] },
      openRegistrations: true,
      usage: { users: { total: row?.n ?? 0 }, localPosts: posts?.n ?? 0 },
      metadata: { nodeName: 'WorldMesh' },
    },
    200,
    'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"',
    3600,
  );
}

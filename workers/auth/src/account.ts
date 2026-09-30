import type { Auth, Env } from './auth';
import { HttpError, isSameOrigin, json, readJson } from './http';
import { checkUsername } from './username';
import { PRESENCE_TICKET_TTL_S, signPresenceTicket } from '../../presence/src/ticket';

interface SessionUser {
  id: string;
  name: string;
  image?: string | null;
  username?: string | null;
}

/**
 * GET /api/account/me — who is signed in. Answered from the signed session
 * cookie cache on most requests, so it usually costs no D1 read.
 * Signed out is a normal state, not an error: { user: null }.
 */
export async function getMe(request: Request, env: Env, auth: Auth): Promise<Response> {
  const { headers, response } = await auth.api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  return json({ user: response ? publicUser(response.user as SessionUser, env) : null }, 200, cookiesOf(headers));
}

/**
 * POST /api/account/username { username } — claims the user's public handle.
 * A username is set once: it becomes a fediverse identity, and changing it
 * would silently break every remote follower's view of it.
 */
export async function setUsername(request: Request, env: Env, auth: Auth): Promise<Response> {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  if (!isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');

  const body = (await readJson(request, 1024)) as { username?: unknown } | null;
  const check = checkUsername(body?.username);
  if (!check.ok) throw new HttpError(400, check.error);

  // Read through to D1: the cookie cache may predate a username set elsewhere.
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const user = session.user as SessionUser;
  if (user.username) throw new HttpError(409, 'Your username is already set.');

  const now = Date.now();
  try {
    const [update] = await env.DB.batch([
      env.DB.prepare('update "user" set "username" = ?1, "updatedAt" = ?2 where "id" = ?3 and "username" is null').bind(
        check.username,
        new Date(now).toISOString(),
        user.id,
      ),
      env.DB.prepare(
        'insert into profile (user_id, created_at, updated_at) values (?1, ?2, ?2) on conflict (user_id) do nothing',
      ).bind(user.id, now),
    ]);
    if (!update.meta.changes) throw new HttpError(409, 'Your username is already set.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (String(error).includes('UNIQUE constraint failed')) throw new HttpError(409, 'That username is taken.');
    throw error;
  }

  // Re-issue the session cookie cache so the new username shows up immediately.
  const refreshed = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  const updated = { ...user, username: check.username };
  return json({ user: publicUser(updated, env) }, 200, cookiesOf(refreshed.headers));
}

function publicUser(user: SessionUser, env: Env) {
  const domain = env.FEDERATION_DOMAIN || new URL(env.BETTER_AUTH_URL).hostname;
  return {
    id: user.id,
    // Apple shares a name only on the very first sign-in, and users may decline.
    name: user.name?.trim() || user.username || 'WorldMesh user',
    image: user.image ?? null,
    username: user.username ?? null,
    handle: user.username ? `@${user.username}@${domain}` : null,
  };
}

function cookiesOf(headers: Headers | null | undefined): Headers {
  const out = new Headers();
  for (const cookie of headers?.getSetCookie() ?? []) out.append('Set-Cookie', cookie);
  return out;
}

/**
 * POST /api/account/presence-ticket — a short-lived ticket proving this
 * visitor's username to the walk mode presence server (workers/presence), so
 * nobody else can walk around under their name. It carries the username and
 * an expiry only. Off until PRESENCE_SECRET is set.
 */
export async function getPresenceTicket(request: Request, env: Env, auth: Auth): Promise<Response> {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  if (!isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');
  if (!env.PRESENCE_SECRET) throw new HttpError(404, 'Not found.');

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const username = (session.user as SessionUser).username;
  if (!username) throw new HttpError(409, 'Choose a username first.');

  return json({ ticket: await signPresenceTicket(env.PRESENCE_SECRET, username), expiresIn: PRESENCE_TICKET_TTL_S });
}

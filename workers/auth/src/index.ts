/**
 * WorldMesh accounts: Better Auth (Google, GitHub) on D1, plus the two
 * account endpoints the hub needs. Served on the hub's own origin through
 * Worker routes, so the session cookie is first-party and host-only.
 *
 * Deliberately knows nothing about ActivityPub; workers/federation reads the
 * same D1 tables on its own.
 */
import { AUTH_BASE_PATH, configuredProviders, getAuth, type Env } from './auth';
import { getMe, setUsername } from './account';
import { HttpError, json, secure } from './http';

export type { Env };

/** Endpoints worth a per-IP limit in front of everything else. */
const LIMITED = /^\/api\/auth\/(sign-in|callback|sign-out)\b|^\/api\/account\/username$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method !== 'GET' && request.method !== 'POST') {
        throw new HttpError(405, 'Method not allowed.');
      }

      if (LIMITED.test(url.pathname) && env.AUTH_LIMITER) {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.AUTH_LIMITER.limit({ key: `${ip}:${url.pathname.split('/')[3]}` });
        if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.');
      }

      if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
        return secure(await (await getAuth(env)).handler(request));
      }
      if (url.pathname === '/api/account/providers' && request.method === 'GET') {
        return secure(json({ providers: configuredProviders(env) }));
      }
      if (url.pathname === '/api/account/me' && request.method === 'GET') {
        return secure(await getMe(request, env, await getAuth(env)));
      }
      if (url.pathname === '/api/account/username' && request.method === 'POST') {
        return secure(await setUsername(request, env, await getAuth(env)));
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof HttpError) return secure(json({ error: error.message }, error.status));
      console.error('auth worker error', error);
      return secure(json({ error: 'Something went wrong.' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

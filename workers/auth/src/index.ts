/**
 * WorldMesh accounts: Better Auth (email + password, Google, Apple, GitHub,
 * Discord) on D1, plus the account endpoints the hub needs and the Avatar
 * Wallet (src/avatars). Served on the hub's own origin through Worker routes,
 * so the session cookie is first-party and host-only.
 *
 * Deliberately knows nothing about ActivityPub; workers/federation reads the
 * same D1 tables on its own. The Avatar Wallet is equally separate from it.
 */
import { AUTH_BASE_PATH, configuredProviders, getAuth, passwordOptions, type Env } from './auth';
import { getMe, setUsername } from './account';
import { AVATAR_BASE_PATH, handleAvatarRequest } from './avatars/routes';
import { HttpError, json, secure } from './http';
import { handleWorldsRequest, page, PageError, WORLDS_PATH, type WorldsEnv } from './worlds';

export type { Env };

type WorkerEnv = Env & WorldsEnv;

/** Endpoints worth a per-IP limit in front of everything else. */
const LIMITED =
  /^\/api\/auth\/(sign-in|sign-up|callback|sign-out|request-password-reset|reset-password|send-verification-email)\b|^\/api\/account\/username$|^\/api\/(worlds)$|^\/api\/account\/avatar\/(connect|callback|connections|select|disconnect|handoff|resolve)\b/;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      const preflight = request.method === 'OPTIONS' && url.pathname === `${AVATAR_BASE_PATH}/resolve`;
      if (request.method !== 'GET' && request.method !== 'POST' && !preflight) {
        throw new HttpError(405, 'Method not allowed.');
      }

      // Only submitting a world is limited, not reading the directory.
      const limited = !preflight && !(url.pathname === WORLDS_PATH && request.method === 'GET') && LIMITED.exec(url.pathname);
      if (limited && env.AUTH_LIMITER) {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const bucket = limited[3] ? `avatar-${limited[3]}` : limited[2] ?? url.pathname.split('/')[3];
        const { success } = await env.AUTH_LIMITER.limit({ key: `${ip}:${bucket}` });
        if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.');
      }

      if (url.pathname.startsWith(`${AVATAR_BASE_PATH}/`)) {
        const exec = ctx ?? { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) };
        return secure(await handleAvatarRequest(request, env, () => getAuth(env), exec));
      }

      if (url.pathname === WORLDS_PATH || url.pathname.startsWith(`${WORLDS_PATH}/`) || url.pathname === '/api/account/worlds') {
        const exec = ctx ?? { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) };
        const response = await handleWorldsRequest(request, env, () => getAuth(env), exec);
        // The public directory is the same for everyone and cached; everything else is per-user.
        return url.pathname === WORLDS_PATH && request.method === 'GET' ? response : secure(response);
      }

      if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
        return secure(await (await getAuth(env)).handler(request));
      }
      if (url.pathname === '/api/account/providers' && request.method === 'GET') {
        return secure(json({ providers: configuredProviders(env), ...passwordOptions(env) }));
      }
      if (url.pathname === '/api/account/me' && request.method === 'GET') {
        return secure(await getMe(request, env, await getAuth(env)));
      }
      if (url.pathname === '/api/account/username' && request.method === 'POST') {
        return secure(await setUsername(request, env, await getAuth(env)));
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof PageError) return secure(page(error.message, false, 400));
      if (error instanceof HttpError) return secure(json({ error: error.message }, error.status));
      console.error('auth worker error', error);
      return secure(json({ error: 'Something went wrong.' }, 500));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

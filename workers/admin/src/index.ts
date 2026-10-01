/**
 * WorldMesh admin dashboard: https://admin.worldmesh.net
 *
 * One Worker on two routes:
 *   worldmesh.net/api/dashboard/*   the sign-in hand-off (reads the hub session)
 *   admin.worldmesh.net/*           the dashboard itself
 *
 *   GET  /                      overview: users, live, worlds, ads, health, what needs you
 *   GET  /users?q=              accounts, search
 *   GET  /worlds                directory (approved + waiting), views, who is in each
 *   GET  /live                  presence rooms, auto-refreshing
 *   GET  /ads                   billboard ads and revenue (actions stay in workers/ads)
 *   GET  /federation            followers, deliveries, Avatar Wallet
 *   GET  /traffic               Cloudflare analytics (needs CF_API_TOKEN)
 *   GET  /system                service + world health, data sources, admins
 *   GET  /auth/callback         hand-off landing
 *   POST /auth/logout
 *
 * Read-only by design: approving worlds and reviewing ads keep using their
 * existing, already-guarded flows, which the dashboard links to.
 */
import { assertConfigured, type Env } from './env';
import { adsPage, federationPage, livePage, overview, systemPage, trafficPage, usersPage, worldsPage } from './pages';
import { esc, htmlResponse, messagePage } from './render';
import { callback, currentAdmin, HANDOFF_PATH, handoff, isSameOrigin, logout, startLogin } from './session';

export type { Env };

const PAGES = {
  '/': overview,
  '/users': usersPage,
  '/worlds': worldsPage,
  '/live': livePage,
  '/ads': adsPage,
  '/federation': federationPage,
  '/traffic': trafficPage,
  '/system': systemPage,
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('admin worker error', error);
      return htmlResponse(messagePage('Something went wrong', `<p>${esc(error instanceof Error ? error.message : 'Unknown error')}</p>`), 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  assertConfigured(env);
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === HANDOFF_PATH && method === 'GET') {
    return handoff(request, env, (email) =>
      htmlResponse(
        messagePage(
          'Not an admin',
          `<p>You are signed in as <strong>${esc(email)}</strong>, which is not a WorldMesh admin account (or its email is not verified).</p>`,
        ),
        403,
      ),
    );
  }
  if (pathname.startsWith('/api/dashboard/')) return new Response('Not found', { status: 404 });

  if (pathname === '/auth/callback' && method === 'GET') return callback(request, env);
  if (pathname === '/auth/logout' && method === 'POST') {
    if (!isSameOrigin(request, env)) return new Response('Forbidden', { status: 403 });
    return logout(env);
  }
  if (pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });

  const page = PAGES[pathname as keyof typeof PAGES];
  if (!page || (method !== 'GET' && method !== 'HEAD')) {
    return htmlResponse(messagePage('Not found', '<p><a href="/">Back to the dashboard</a></p>'), 404);
  }

  const admin = await currentAdmin(request, env);
  if (!admin) return startLogin(env);
  return page(request, env, admin);
}

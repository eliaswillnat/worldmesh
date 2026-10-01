import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { perDay } from '../src/data';
import type { RoomStats } from '../src/env';

const HUB = 'https://worldmesh.net';
const ADMIN = 'https://admin.worldmesh.net';
const ADMIN_EMAIL = 'boss@worldmesh.test';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let database: TestDatabase;
let env: Env;
let clock = Date.UTC(2026, 9, 1, 12);
let rooms: Map<string, RoomStats>;
let fetched: string[];

// ── Fakes ──────────────────────────────────────────────────────────────────

function fakeRooms(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      stats: async () => rooms.get((id as unknown as { name: string }).name) ?? { connections: 0, peers: [] },
    }),
  } as unknown as DurableObjectNamespace;
}

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url.includes('down.example')) throw new TypeError('connection refused');
  if (url.startsWith(HUB)) return new Response('ok', { status: 200 });
  return new Response('nope', { status: 404 });
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function addUser(id: string, email: string, options: { verified?: boolean; username?: string; created?: number; provider?: string } = {}) {
  const created = new Date(options.created ?? clock).toISOString();
  await env.DB.prepare(
    'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username) values (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, `Name of ${id}`, email, options.verified === false ? 0 : 1, created, created, options.username ?? null)
    .run();
  await env.DB.prepare(
    'insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?)',
  )
    .bind(`a_${id}`, `ext_${id}`, options.provider ?? 'google', id, created, created)
    .run();
}

async function addSession(userId: string, token: string, expiresIn = 30 * DAY): Promise<string> {
  const iso = new Date(clock).toISOString();
  await env.DB.prepare('insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values (?, ?, ?, ?, ?, ?)')
    .bind(`s_${token}`, new Date(clock + expiresIn).toISOString(), token, iso, iso, userId)
    .run();
  return `s_${token}`;
}

function call(url: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(url, { redirect: 'manual', ...init }), env);
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? '';
  return header.split(';')[0];
}

/** The whole sign-in: hub cookie → hand-off → callback → dashboard cookie. */
async function signIn(token: string): Promise<string> {
  const handoff = await call(`${HUB}/api/dashboard/handoff`, { headers: { Cookie: `__Secure-worldmesh.session_token=${token}.sig` } });
  expect(handoff.status).toBe(303);
  const location = handoff.headers.get('Location')!;
  expect(location.startsWith(`${ADMIN}/auth/callback?ticket=`)).toBe(true);
  const landed = await call(location);
  expect(landed.status).toBe(303);
  expect(landed.headers.get('Location')).toBe('/');
  const cookie = cookieFrom(landed);
  expect(cookie.startsWith('__Host-wm_admin=')).toBe(true);
  expect(landed.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
  expect(landed.headers.get('Set-Cookie')).toMatch(/Secure/);
  return cookie;
}

async function page(path: string, cookie: string): Promise<string> {
  const response = await call(`${ADMIN}${path}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'/);
  return response.text();
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never, fileURLToPath(new URL('./wrangler.test.toml', import.meta.url)));
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1, 12);
  rooms = new Map();
  fetched = [];
  env = {
    DB: database.db,
    WORLDS: database.env.WORLDS as KVNamespace,
    VIEWS: database.env.VIEWS as KVNamespace,
    ROOMS: fakeRooms(),
    HUB_ORIGIN: HUB,
    ADMIN_ORIGIN: ADMIN,
    ADMIN_EMAILS: `${ADMIN_EMAIL}, second@worldmesh.test`,
    ADMIN_SECRET: 'test-secret-test-secret-test-secret-123',
    NOW: () => clock,
    FETCH: fakeFetch,
  };
  await database.db.batch(['ap_follower', 'ap_actor', 'ad_submission', 'avatar', 'avatar_connection', '"session"', 'account', '"user"'].map((t) => database.db.prepare(`delete from ${t}`)));
  for (const kv of [env.WORLDS!, env.VIEWS!]) {
    const list = await kv.list();
    await Promise.all(list.keys.map((key) => kv.delete(key.name)));
  }
  await addUser('admin', ADMIN_EMAIL, { username: 'boss' });
});

// ── Access ─────────────────────────────────────────────────────────────────

describe('who gets in', () => {
  it('sends a visitor without a dashboard cookie to the hand-off', async () => {
    const response = await call(`${ADMIN}/`);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${HUB}/api/dashboard/handoff`);
  });

  it('sends someone not signed in on the hub to the hub sign-in, coming back to the hand-off', async () => {
    const response = await call(`${HUB}/api/dashboard/handoff`);
    expect(response.headers.get('Location')).toBe(`${HUB}/?login=1&next=%2Fapi%2Fdashboard%2Fhandoff`);
  });

  it('lets a verified admin in and keeps them in', async () => {
    await addSession('admin', 'admintoken0000000000');
    const cookie = await signIn('admintoken0000000000');
    const html = await page('/', cookie);
    expect(html).toContain('Overview');
    expect(html).toContain(ADMIN_EMAIL);
  });

  it('refuses a signed-in account that is not on the list', async () => {
    await addUser('someone', 'someone@example.com');
    await addSession('someone', 'sometoken00000000000');
    const response = await call(`${HUB}/api/dashboard/handoff`, { headers: { Cookie: '__Secure-worldmesh.session_token=sometoken00000000000.sig' } });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not a WorldMesh admin');
  });

  it('refuses an admin email that is not verified', async () => {
    await env.DB.prepare('update "user" set "emailVerified" = 0 where id = ?').bind('admin').run();
    await addSession('admin', 'admintoken0000000000');
    const response = await call(`${HUB}/api/dashboard/handoff`, { headers: { Cookie: '__Secure-worldmesh.session_token=admintoken0000000000.sig' } });
    expect(response.status).toBe(403);
  });

  it('ignores an expired hub session', async () => {
    await addSession('admin', 'admintoken0000000000', -MINUTE);
    const response = await call(`${HUB}/api/dashboard/handoff`, { headers: { Cookie: '__Secure-worldmesh.session_token=admintoken0000000000.sig' } });
    expect(response.headers.get('Location')).toContain('/?login=1');
  });

  it('rejects a tampered or forged dashboard cookie', async () => {
    await addSession('admin', 'admintoken0000000000');
    const cookie = await signIn('admintoken0000000000');
    const [name, value] = cookie.split('=');
    const [body, mac] = value.split('.');
    const forged = `${name}=${body}x.${mac}`;
    expect((await call(`${ADMIN}/`, { headers: { Cookie: forged } })).status).toBe(303);
    expect((await call(`${ADMIN}/`, { headers: { Cookie: `${name}=${body}.AAAA` } })).status).toBe(303);
  });

  it('ends access as soon as the hub session is gone (signed out on the hub)', async () => {
    const sid = await addSession('admin', 'admintoken0000000000');
    const cookie = await signIn('admintoken0000000000');
    await env.DB.prepare('delete from "session" where id = ?').bind(sid).run();
    const response = await call(`${ADMIN}/`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
  });

  it('ends access when the email is taken off ADMIN_EMAILS', async () => {
    await addSession('admin', 'admintoken0000000000');
    const cookie = await signIn('admintoken0000000000');
    env.ADMIN_EMAILS = 'second@worldmesh.test';
    expect((await call(`${ADMIN}/`, { headers: { Cookie: cookie } })).status).toBe(303);
  });

  it('does not accept a hand-off ticket after a minute', async () => {
    await addSession('admin', 'admintoken0000000000');
    const handoff = await call(`${HUB}/api/dashboard/handoff`, { headers: { Cookie: '__Secure-worldmesh.session_token=admintoken0000000000.sig' } });
    clock += 2 * MINUTE;
    const landed = await call(handoff.headers.get('Location')!);
    expect(landed.headers.get('Location')).toBe(`${HUB}/api/dashboard/handoff`);
    expect(landed.headers.get('Set-Cookie')).toBeNull();
  });

  it('does not accept a dashboard cookie as a ticket, or the other way round', async () => {
    await addSession('admin', 'admintoken0000000000');
    const cookie = await signIn('admintoken0000000000');
    const value = cookie.split('=')[1];
    const landed = await call(`${ADMIN}/auth/callback?ticket=${encodeURIComponent(value)}`);
    expect(landed.headers.get('Set-Cookie')).toBeNull();
  });

  it('never lets the dashboard cookie outlive the hub session', async () => {
    await addSession('admin', 'admintoken0000000000', 30 * MINUTE);
    const cookie = await signIn('admintoken0000000000');
    expect(cookie).toBeTruthy();
    clock += 31 * MINUTE;
    expect((await call(`${ADMIN}/`, { headers: { Cookie: cookie } })).status).toBe(303);
  });

  it('signs out only with a same-origin POST', async () => {
    expect((await call(`${ADMIN}/auth/logout`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const response = await call(`${ADMIN}/auth/logout`, { method: 'POST', headers: { Origin: ADMIN, 'Sec-Fetch-Site': 'same-origin' } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
  });

  it('answers nothing else under /api/dashboard on the hub', async () => {
    expect((await call(`${HUB}/api/dashboard/anything`)).status).toBe(404);
  });

  it('refuses to start without a proper secret', async () => {
    env.ADMIN_SECRET = 'short';
    expect((await call(`${ADMIN}/`)).status).toBe(500);
  });
});

// ── Pages ──────────────────────────────────────────────────────────────────

describe('what an admin sees', () => {
  let cookie: string;

  beforeEach(async () => {
    await addSession('admin', 'admintoken0000000000');
    cookie = await signIn('admintoken0000000000');
  });

  it('counts users, sign-ups and providers', async () => {
    await addUser('u1', 'one@example.com', { created: clock - 2 * DAY, provider: 'github', username: 'one' });
    await addUser('u2', 'two@example.com', { created: clock - 40 * DAY, provider: 'discord', verified: false });
    const html = await page('/users', cookie);
    expect(html).toContain('one@example.com');
    expect(html).toContain('@one');
    expect(html).toContain('unverified');
    expect(html).toMatch(/New, 7 days<\/div><div class="stat-value">2</); // admin (today) + u1

    const search = await page('/users?q=two', cookie);
    expect(search).toContain('two@example.com');
    expect(search).not.toContain('one@example.com');
    // LIKE wildcards are literal.
    expect(await page('/users?q=%25', cookie)).toContain('No account matches.');
  });

  it('shows the directory, waiting submissions with their approve link, views and who is online', async () => {
    await env.WORLDS!.put('approved:forest', JSON.stringify({ id: 'forest', name: 'Forest', url: 'https://forest.worldmesh.net/', creator: 'Elias', approvedAt: '2026-09-30T10:00:00Z' }));
    await env.WORLDS!.put(
      'pending:evil',
      JSON.stringify({ id: 'evil', name: '<script>alert(1)</script>', url: 'javascript:alert(1)', email: 'maker@example.com', approveToken: 'tok123', submittedAt: '2026-10-01T11:00:00Z' }),
    );
    await env.VIEWS!.put('count:https://forest.worldmesh.net/', '42');
    rooms.set('world:https://forest.worldmesh.net', { connections: 3, peers: [{ id: 'a', name: 'one', alias: '', position: [0, 0, 0] }, { id: 'b', name: '', alias: 'Quiet Fox', position: [1, 0, 1] }] });
    rooms.set('lobby', { connections: 1, peers: [{ id: 'c', name: '', alias: '', position: [0, 0, 0] }] });

    const worlds = await page('/worlds', cookie);
    expect(worlds).toContain('Forest');
    expect(worlds).toContain('>42<');
    expect(worlds).toContain(`${HUB}/api/approve?id=evil&amp;token=tok123`);
    expect(worlds).toContain('maker@example.com');
    expect(worlds).not.toContain('<script>alert(1)</script>');
    expect(worlds).toContain('&lt;script&gt;');
    expect(worlds).not.toContain('href="javascript:');

    const live = await page('/live', cookie);
    expect(live).toContain('http-equiv="refresh"');
    expect(live).toContain('@one');
    expect(live).toContain('Quiet Fox');
    expect(live).toContain('guest');

    const overview = await page('/', cookie);
    expect(overview).toMatch(/Online now<\/div><div class="stat-value"><span class="live-dot"><\/span>3</);
    expect(overview).toContain('World waiting');
  });

  it('keeps going when a source is missing', async () => {
    env.WORLDS = undefined;
    env.ROOMS = undefined;
    const html = await page('/', cookie);
    expect(html).toContain('No WORLDS binding');
    expect(html).toContain('Sign-ups, last 30 days');
  });

  it('shows ads and captured revenue, linking to the existing review page', async () => {
    const insert = env.DB.prepare(
      `insert into ad_submission (id, billboard_id, status, media_type, media_mime, media_key, media_bytes, advertiser_name, destination_url, contact_email,
        manage_token_hash, amount_cents, currency, created_at, updated_at, authorized_at, captured_at, activated_at, ends_at, hold_expires_at)
       values (?, ?, ?, 'image', 'image/png', 'k', 10, ?, 'https://shop.example', 'ads@example.com', 'h', 200, 'eur', ?, ?, ?, ?, ?, ?, ?)`,
    );
    await insert.bind('aaaaaaaaaaaaaaaaaaaaaaaaaa', 'f01-main', 'active', 'Shop A', clock, clock, clock, clock, clock, clock + DAY, null).run();
    await insert.bind('bbbbbbbbbbbbbbbbbbbbbbbbbb', 'f02-main', 'pending', 'Shop B', clock, clock, clock, null, null, null, null).run();
    const html = await page('/ads', cookie);
    expect(html).toContain('Shop A');
    expect(html).toContain('€2.00');
    expect(html).toContain(`${HUB}/api/ads/admin/review?id=bbbbbbbbbbbbbbbbbbbbbbbbbb`);
    expect(await page('/', cookie)).toContain('Ad waiting');
  });

  it('renders the fediverse page on an empty database', async () => {
    const html = await page('/federation', cookie);
    expect(html).toContain('Followers');
    expect(html).toContain('No delivery errors.');
  });

  it('explains how to connect traffic when no token is set, and renders it when one is', async () => {
    expect(await page('/traffic', cookie)).toContain('CF_API_TOKEN');

    env.CF_API_TOKEN = 'token';
    env.CF_ZONE_ID = 'zone';
    env.FETCH = async () =>
      Response.json({
        data: {
          viewer: {
            zones: [
              {
                httpRequests1dGroups: [
                  { dimensions: { date: '2026-09-30' }, sum: { requests: 1000, pageViews: 300, bytes: 5_000_000, threats: 2, countryMap: [{ clientCountryName: 'DE', requests: 700 }] }, uniq: { uniques: 120 } },
                  { dimensions: { date: '2026-10-01' }, sum: { requests: 500, pageViews: 100, bytes: 1_000_000, threats: 0, countryMap: [{ clientCountryName: 'PH', requests: 400 }] }, uniq: { uniques: 80 } },
                ],
              },
            ],
          },
        },
      });
    const html = await page('/traffic', cookie);
    expect(html).toMatch(/Visitors, 30 d<\/div><div class="stat-value">200</);
    expect(html).toContain('6.0 MB');
    expect(html).toContain('PH');
  });

  it('checks every service and every listed world', async () => {
    await env.WORLDS!.put('approved:gone', JSON.stringify({ id: 'gone', name: 'Gone', url: 'https://down.example/' }));
    env.PRESENCE_URL = 'https://presence.example/';
    const html = await page('/system', cookie);
    expect(fetched).toContain(`${HUB}/api/account/providers`);
    expect(fetched).toContain('https://down.example/');
    expect(html).toContain('Gone');
    expect(html).toContain('Down');
    expect(html).toContain('Presence (workers/presence)');
    expect(html).toContain('0 of 1 up');
  });
});

describe('perDay', () => {
  it('buckets by UTC day and drops anything outside the window', () => {
    const at = Date.UTC(2026, 9, 1, 12);
    const days = perDay([at, at - DAY, at - DAY - 1000, at - 40 * DAY], 3, at);
    expect(days).toEqual([
      { day: '2026-09-29', n: 0 },
      { day: '2026-09-30', n: 2 },
      { day: '2026-10-01', n: 1 },
    ]);
  });
});

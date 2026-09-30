import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { readFileSync } from 'node:fs';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { createAuth } from '../src/auth';
// @ts-expect-error plain JS script, no declarations
import { backfillSql, collectLegacyWorlds } from '../../../scripts/backfill-worlds.mjs';

const ORIGIN = 'https://worldmesh.net';
const SECRET = 'test-secret-test-secret-test-secret-123';
const SESSION_COOKIE = '__Secure-worldmesh.session_token';

let database: TestDatabase;
let env: Env & { NOTIFICATION_EMAIL?: string; FROM_EMAIL?: string };
let pending: Promise<unknown>[] = [];
let mails: { to: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never);
  env = {
    DB: database.db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    FEDERATION_DOMAIN: 'worldmesh.net',
    RESEND_API_KEY: 're_test',
    FROM_EMAIL: 'WorldMesh <worlds@worldmesh.net>',
    NOTIFICATION_EMAIL: 'admin@example.com',
  };
}, 30_000);

afterAll(async () => {
  await database?.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
  mails = [];
});

function stubResend() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://api.resend.com/emails') {
      mails.push(JSON.parse(String(init?.body)));
      return new Response('{"id":"x"}');
    }
    return realFetch(input, init);
  });
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx as unknown as ExecutionContext);
  await Promise.all(pending);
  pending = [];
  return response;
}

const submit = (body: unknown, headers: Record<string, string> = {}) =>
  call('/api/worlds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

async function signedInUser(email: string, username?: string) {
  const ctx = await createAuth(env).$context;
  const user = await ctx.internalAdapter.createUser({ name: 'Test User', email, emailVerified: true });
  if (username) await env.DB.prepare('update "user" set username = ?1 where id = ?2').bind(username, user.id).run();
  const session = await ctx.internalAdapter.createSession(user.id);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return { user, cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${session.token}.${signature}`)}` };
}

const directory = async () => (await (await call('/api/worlds')).json()) as Record<string, unknown>[];

function approveLink(): { id: string; token: string } {
  const link = mails.map((m) => /https:\/\/worldmesh\.net\/api\/worlds\/approve\?\S+/.exec(m.text)?.[0]).find(Boolean)!;
  const params = new URL(link).searchParams;
  return { id: params.get('id')!, token: params.get('token')! };
}

const approve = (id: string, token: string) =>
  call('/api/worlds/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id, token }).toString(),
  });

describe('submitting a world', () => {
  it('links it to the signed-in account and keeps it out of the directory until approved', async () => {
    stubResend();
    const { user, cookie } = await signedInUser('maker@example.com', 'maker');
    const res = await submit(
      { id: 'lava-land-abc123', name: 'Lava Land', url: 'https://lava.example/', creator: 'Maker', cover: 'https://cdn.example/c.webp' },
      { Cookie: cookie },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ world: { id: 'lava-land-abc123', status: 'pending', owned: true } });

    const row = await env.DB.prepare('select owner_user_id, status, source, review_token_hash from world where id = ?1')
      .bind('lava-land-abc123')
      .first<{ owner_user_id: string; status: string; source: string; review_token_hash: string }>();
    expect(row).toMatchObject({ owner_user_id: user.id, status: 'pending', source: 'submitted' });
    expect(row?.review_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('admin@example.com');
    expect(mails[0].text).toContain('@maker <maker@example.com>');
    expect((await directory()).some((w) => w.url === 'https://lava.example/')).toBe(false);

    const mine = (await (await call('/api/account/worlds', { headers: { Cookie: cookie } })).json()) as { worlds: { id: string; status: string }[] };
    expect(mine.worlds).toEqual([expect.objectContaining({ id: 'lava-land-abc123', status: 'pending', owner: 'maker' })]);
  });

  it('accepts guests with an email, and refuses guests without one', async () => {
    stubResend();
    expect((await submit({ name: 'Guest World', url: 'https://guest.example/' })).status).toBe(400);
    const res = await submit({ name: 'Guest World', url: 'https://guest.example/', email: 'guest@example.com', cover: 'data:image/webp;base64,AAAA' });
    expect(res.status).toBe(201);
    const { world } = (await res.json()) as { world: { id: string; owned: boolean } };
    expect(world.owned).toBe(false);
    expect(world.id).toMatch(/^guest-world-[0-9a-f]{6}$/);
    const row = await env.DB.prepare('select owner_user_id, contact_email, cover_url from world where id = ?1').bind(world.id).first();
    expect(row).toEqual({ owner_user_id: null, contact_email: 'guest@example.com', cover_url: null });
  });

  it('refuses duplicates, bad links and cross-site posts; fakes success for bots', async () => {
    expect((await submit({ name: 'Again', url: 'https://guest.example/', email: 'a@example.com' })).status).toBe(409);
    expect((await submit({ name: 'Bad', url: 'javascript:alert(1)', email: 'a@example.com' })).status).toBe(400);
    expect((await submit({ name: 'X', url: 'https://x.example/', email: 'a@example.com' }, { Origin: 'https://evil.example' })).status).toBe(403);
    const bot = await submit({ name: 'Bot', url: 'https://bot.example/', email: 'b@example.com', botTrap: 'spam' });
    expect(bot.status).toBe(201);
    expect(await env.DB.prepare("select 1 from world where url = 'https://bot.example/'").first()).toBeNull();
  });
});

describe('approving a world', () => {
  it('asks for a click, then publishes it and emails the owner', async () => {
    stubResend();
    const { cookie } = await signedInUser('builder@example.com', 'builder');
    await submit({ name: 'Moon Base', url: 'https://moon.example/', description: 'Low gravity' }, { Cookie: cookie });
    const { id, token } = approveLink();
    mails = [];

    const confirm = await call(`/api/worlds/approve?id=${id}&token=${token}`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('<form method="post"');
    expect((await directory()).some((w) => w.id === id)).toBe(false);

    expect((await approve(id, 'wrong')).status).toBe(400);
    const done = await approve(id, token);
    expect(await done.text()).toContain('approved and live');
    expect(mails.map((m) => m.to)).toEqual(['builder@example.com']);

    const listed = (await directory()).find((w) => w.id === id);
    expect(listed).toEqual({
      id,
      name: 'Moon Base',
      url: 'https://moon.example/',
      description: 'Low gravity',
      creator: '@builder',
      owner: 'builder',
      addedAt: expect.any(String),
      approvedAt: expect.any(String),
    });
    expect(await (await approve(id, token)).text()).toContain('already live');
  });

  it('serves the directory publicly cacheable', async () => {
    const res = await call('/api/worlds');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('backfill from KV and community.json', () => {
  const community = JSON.parse(readFileSync(new URL('../../../apps/hub/src/community.json', import.meta.url), 'utf8')) as {
    id: string;
    name: string;
    url: string;
    cover?: string;
    creator?: string;
    portfolio?: string;
    addedAt: string;
  }[];

  it('copies every world with its listing date, links verified owners, and is safe to run twice', async () => {
    const { user } = await signedInUser('kv-owner@example.com');
    const kv = [
      {
        name: 'approved:old-world',
        value: JSON.stringify({ id: 'old-world', name: "Old 'World'", url: 'https://old.example/', email: 'KV-Owner@example.com', approvedAt: '2026-09-01T10:00:00Z', addedAt: '2026-09-01T10:00:00Z' }),
      },
      { name: 'pending:waiting', value: JSON.stringify({ id: 'waiting', name: 'Waiting', url: 'https://waiting.example/', email: 'w@example.com', approveToken: 'old' }) },
      // Same URL as a community world: KV wins, community is skipped.
      { name: 'approved:dup', value: JSON.stringify({ id: 'dup', name: 'Dup', url: community[0].url, approvedAt: '2026-09-02T00:00:00Z' }) },
      { name: 'unrelated', value: 'x' },
    ];
    const entries = collectLegacyWorlds(kv, community);
    const run = async () => {
      const { sql, approveLinks } = backfillSql(entries, { token: () => 'fixed-token' });
      await env.DB.batch(sql.trim().split('\n').map((s: string) => env.DB.prepare(s)));
      return approveLinks as string[];
    };
    const links = await run();
    await run();

    const listed = await directory();
    expect(listed.filter((w) => w.url === 'https://old.example/')).toEqual([
      { id: 'old-world', name: "Old 'World'", url: 'https://old.example/', addedAt: '2026-09-01T10:00:00.000Z', approvedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    const owner = await env.DB.prepare("select owner_user_id from world where id = 'old-world'").first<{ owner_user_id: string }>();
    expect(owner?.owner_user_id).toBe(user.id);

    for (const world of community.slice(1)) {
      const { id, name, url, cover, creator, portfolio, addedAt } = world;
      expect(listed.find((w) => w.url === url)).toMatchObject({
        id, name, url, cover, creator, portfolio, addedAt: new Date(addedAt).toISOString(),
      });
    }
    expect(listed.find((w) => w.url === community[0].url)?.id).toBe('dup');

    expect(listed.some((w) => w.id === 'waiting')).toBe(false);
    expect(links).toEqual(['Waiting: https://worldmesh.net/api/worlds/approve?id=waiting&token=fixed-token']);
    expect(await (await approve('waiting', 'fixed-token')).text()).toContain('approved and live');
  });
});

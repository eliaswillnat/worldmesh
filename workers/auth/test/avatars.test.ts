import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { createAuth } from '../src/auth';
import { atprotoClientId, BUILDING_UPLOAD_SCOPE, UPLOAD_SCOPE } from '../src/avatars/atproto';
import { fromBase64url, pkceChallenge, seal } from '../src/avatars/crypto';
import { recheckStale } from '../src/avatars/buildingLinks';
import { sharePayload, type SignedShare } from '../src/avatars/share';

const ORIGIN = 'https://worldmesh.net';
const WORLD = 'https://forest.worlds.example.org';
const SECRET = 'test-secret-test-secret-test-secret-123';
const AVATAR_SECRET = 'avatar-secret-avatar-secret-avatar-secret';
const SESSION_COOKIE = '__Secure-worldmesh.session_token';
const FLOW_COOKIE = '__Secure-worldmesh.avatar_flow';
const UPLOAD_COOKIE = '__Secure-worldmesh.avatar_upload';
const VROID = 'https://hub.vroid.com';
const S3_URL = 'https://vroid-hub.s3.ap-northeast-1.amazonaws.com/model.vrm?X-Amz-Signature=abc';
const SKETCHFAB = 'https://sketchfab.com';
const SKETCHFAB_API = 'https://api.sketchfab.com';
const SKETCHFAB_GLB = 'https://sketchfab-prod-media.s3.amazonaws.com/archives/model.glb?X-Amz-Signature=def';
const SKETCHFAB_USER = '2e56234e58bb433b86def3a6274166e9';
const SKETCHFAB_MODEL = '1cb3298227d5469284fe122dbd8baf5f';

/** Everything the client may ask for: uploading characters and buildings, nothing more. */
const CLIENT_SCOPE = 'atproto repo:app.at3d.avatar?action=create repo:net.worldmesh.building?action=create blob:model/gltf-binary';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const HANDLE = 'alice.pds-fixture.net';
const PDS = 'https://pds.pds-fixture.net';
const AS = 'https://auth.pds-fixture.net';

let database: TestDatabase;
let env: Env;

// ── Provider HTTP stubs ──────────────────────────────────────────────────────
// Only provider hosts are stubbed; anything else (the local D1 proxy) passes through.
type Handler = (request: Request) => Response | Promise<Response>;
const routes = new Map<string, Handler>();
const calls: Request[] = [];
const STUBBED = new Set([
  'hub.vroid.com',
  'sketchfab.com',
  'api.sketchfab.com',
  'plc.directory',
  'cloudflare-dns.com',
  'pds.pds-fixture.net',
  'auth.pds-fixture.net',
  'alice.pds-fixture.net',
  '10.0.0.1',
  'forest.worlds.example.org',
  'api.resend.com',
]);
const realFetch = globalThis.fetch;

function route(method: string, url: string, handler: Handler) {
  routes.set(`${method} ${url}`, handler);
}
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never);
  env = {
    DB: database.db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    AVATAR_SECRET,
    VROID_CLIENT_ID: 'vroid-client',
    VROID_CLIENT_SECRET: 'vroid-client-secret',
    SKETCHFAB_CLIENT_ID: 'sketchfab-client',
    SKETCHFAB_CLIENT_SECRET: 'sketchfab-client-secret',
    ADMIN_EMAILS: 'Reviewer@example.com, someone@example.com',
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!STUBBED.has(url.hostname)) return realFetch(input, init);
    calls.push(request.clone());
    const handler = routes.get(`${request.method} ${url.origin}${url.pathname}`);
    if (!handler) throw new Error(`Unexpected provider request: ${request.method} ${request.url}`);
    return handler(request);
  });
}, 30_000);

afterEach(() => {
  routes.clear();
  calls.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await database?.dispose();
});

function call(path: string, init: RequestInit = {}, withEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), withEnv);
}

async function signedInUser(email: string, emailVerified = true) {
  const ctx = await createAuth(env).$context;
  const user = await ctx.internalAdapter.createUser({ name: 'Test User', email, emailVerified });
  const session = await ctx.internalAdapter.createSession(user.id);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return { user, cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${session.token}.${signature}`)}` };
}

function post(path: string, cookie: string | null, body: unknown, origin = ORIGIN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin };
  if (cookie) headers.Cookie = cookie;
  return call(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function cookieValue(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!cookie) throw new Error(`no ${name} cookie`);
  return cookie.split(';')[0].slice(name.length + 1);
}

// ── VRoid Hub fixtures ───────────────────────────────────────────────────────

function vroidModel(id: string, userId: string, name: string) {
  return {
    id,
    name,
    is_private: false,
    portrait_image: { sq300: { url: `https://vroid-hub.pximg.net/images/${id}/sq300.png` } },
    character: { id: `char-${id}`, name: `${name} character`, user: { id: userId } },
    latest_character_model_version: { spec_version: '1.0' },
  };
}

async function connectVroid(cookie: string, account = 'vroid-user-1') {
  const start = await post('/api/account/avatar/connect/vroid', cookie, {});
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const flow = cookieValue(start, FLOW_COOKIE);

  let verifier = '';
  route('POST', `${VROID}/oauth/token`, async (request) => {
    const form = new URLSearchParams(await request.text());
    expect(request.headers.get('X-Api-Version')).toBe('11');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/account/avatar/callback/vroid`);
    verifier = form.get('code_verifier') ?? '';
    return reply({ access_token: 'vroid-access-1', refresh_token: 'vroid-refresh-1', token_type: 'Bearer', expires_in: 3600 });
  });
  route('GET', `${VROID}/api/account`, (request) => {
    expect(request.headers.get('Authorization')).toBe('Bearer vroid-access-1');
    return reply({ data: { user_detail: { user: { id: account, name: 'Vee' } } } });
  });
  const callback = await call(
    `/api/account/avatar/callback/vroid?code=the-code&state=${authorize.searchParams.get('state')}`,
    { headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${flow}` } },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected`);
  expect(await pkceChallenge(verifier)).toBe(authorize.searchParams.get('code_challenge'));
  const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as {
    connections: { id: string; provider: string }[];
  };
  return wallet.connections.find((c) => c.provider === 'vroid')!.id;
}

function stubDownload(expectedToken = 'vroid-access-1') {
  route('POST', `${VROID}/api/download_licenses`, async (request) => {
    expect(request.headers.get('Authorization')).toBe(`Bearer ${expectedToken}`);
    expect(await request.json()).toEqual({ character_model_id: 'model-1' });
    return reply({ data: { id: 'license-1', character_model_id: 'model-1', expires_at: '2026-10-01T00:00:00Z' } });
  });
  route('GET', `${VROID}/api/download_licenses/license-1/download`, () => new Response(null, { status: 302, headers: { Location: S3_URL } }));
}

async function selectVroidModel(cookie: string, connectionId: string) {
  route('GET', `${VROID}/api/character_models/model-1`, () =>
    reply({ data: { character_model: vroidModel('model-1', 'vroid-user-1', 'Aoi') } }),
  );
  const res = await post('/api/account/avatar/select', cookie, { connectionId, avatarId: 'model-1' });
  expect(res.status).toBe(200);
  return res;
}

async function ticketFor(cookie: string): Promise<string> {
  const res = await post('/api/account/avatar/handoff', cookie, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

function resolveFromWorld(ticket: unknown) {
  return worker.fetch(
    new Request(`${ORIGIN}/api/account/avatar/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WORLD, 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ ticket }),
    }),
    env,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('avatar wallet', () => {
  it('is off until AVATAR_SECRET is set, and needs a session', async () => {
    const { AVATAR_SECRET: _secret, ...withoutSecret } = env;
    const off = await call('/api/account/avatar/wallet', {}, withoutSecret as Env);
    expect(await off.json()).toMatchObject({ enabled: false });
    expect((await call('/api/account/avatar/wallet')).status).toBe(401);
  });

  it('lists configured providers and starts empty', async () => {
    const { cookie } = await signedInUser('wallet@example.com');
    const res = await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      enabled: true,
      providers: [
        { id: 'sketchfab', label: 'Sketchfab' },
        { id: 'vroid', label: 'VRoid Hub' },
        { id: 'atproto', label: 'at3d' },
      ],
      connections: [],
      collection: [],
      selected: null,
    });
  });

  it('refuses cross-site state changes', async () => {
    const { cookie } = await signedInUser('csrf-avatar@example.com');
    for (const path of ['connect/vroid', 'select', 'collect', 'remove', 'rename', 'disconnect', 'handoff', 'upload/grant', 'upload/done']) {
      const res = await post(`/api/account/avatar/${path}`, cookie, {}, 'https://evil.example.org');
      expect(res.status).toBe(403);
    }
  });
});

describe('VRoid Hub', () => {
  it('starts OAuth with PKCE and a browser-bound flow cookie', async () => {
    const { cookie } = await signedInUser('vroid-start@example.com');
    const res = await post('/api/account/avatar/connect/vroid', cookie, {});
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${VROID}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'vroid-client',
      redirect_uri: `${ORIGIN}/api/account/avatar/callback/vroid`,
      scope: 'default',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
    const flow = res.headers.getSetCookie().find((c) => c.startsWith(FLOW_COOKIE))!;
    expect(flow).toMatch(/Path=\/api\/account\/avatar\/callback/);
    expect(flow).toMatch(/HttpOnly/);
    expect(flow).toMatch(/SameSite=Lax/);
    expect(flow).toMatch(/Secure/);
    expect(flow).not.toMatch(/Domain=/i);
  });

  it('connects, keeping tokens only in encrypted form', async () => {
    const { user, cookie } = await signedInUser('vroid-connect@example.com');
    await connectVroid(cookie);
    const row = await env.DB.prepare('select * from avatar_connection where user_id = ?').bind(user.id).first<Record<string, string>>();
    expect(row).toMatchObject({ provider: 'vroid', provider_account_id: 'vroid-user-1', display_name: 'Vee', status: 'active' });
    expect(row!.token_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('vroid-access-1');
    expect(JSON.stringify(row)).not.toContain('vroid-refresh-1');
  });

  it('rejects a callback with the wrong state or from another session', async () => {
    const { cookie } = await signedInUser('vroid-state@example.com');
    const other = await signedInUser('vroid-other@example.com');
    const start = await post('/api/account/avatar/connect/vroid', cookie, {});
    const flow = cookieValue(start, FLOW_COOKIE);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state');

    const forged = await call(`/api/account/avatar/callback/vroid?code=x&state=forged`, { headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${flow}` } });
    expect(forged.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);
    const hijack = await call(`/api/account/avatar/callback/vroid?code=x&state=${state}`, {
      headers: { Cookie: `${other.cookie}; ${FLOW_COOKIE}=${flow}` },
    });
    expect(hijack.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);
    const noCookie = await call(`/api/account/avatar/callback/vroid?code=x&state=${state}`, { headers: { Cookie: cookie } });
    expect(noCookie.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);
    expect(calls).toHaveLength(0);
  });

  it("lists the user's own models live and selects one", async () => {
    const { user, cookie } = await signedInUser('vroid-list@example.com');
    const connectionId = await connectVroid(cookie);
    route('GET', `${VROID}/api/account/character_models`, (request) => {
      expect(new URL(request.url).searchParams.get('publication')).toBe('all');
      return reply({ data: [vroidModel('model-1', 'vroid-user-1', 'Aoi'), vroidModel('model-2', 'vroid-user-1', '')] });
    });
    const list = await call(`/api/account/avatar/connections/${connectionId}/avatars`, { headers: { Cookie: cookie } });
    expect(await list.json()).toEqual({
      avatars: [
        {
          id: 'model-1',
          name: 'Aoi',
          thumbnail: 'https://vroid-hub.pximg.net/images/model-1/sq300.png',
          format: 'vrm',
          metadata: { characterId: 'char-model-1', vrmVersion: '1.0', private: false },
        },
        expect.objectContaining({ id: 'model-2', name: ' character' }),
      ],
    });

    const selected = await selectVroidModel(cookie, connectionId);
    expect(((await selected.json()) as { selected: unknown }).selected).toEqual({
      connectionId,
      provider: 'vroid',
      avatarId: 'model-1',
      name: 'Aoi',
      thumbnail: 'https://vroid-hub.pximg.net/images/model-1/sq300.png',
      format: 'vrm',
    });
    const rows = await env.DB.prepare('select * from avatar where user_id = ?').bind(user.id).all();
    expect(rows.results).toHaveLength(1);

    // Someone else's model cannot be picked through this connection.
    route('GET', `${VROID}/api/character_models/model-9`, () => reply({ data: { character_model: vroidModel('model-9', 'someone-else', 'X') } }));
    expect((await post('/api/account/avatar/select', cookie, { connectionId, avatarId: 'model-9' })).status).toBe(404);
  });

  it('keeps several characters, switches between them and removes any of them', async () => {
    const { user, cookie } = await signedInUser('vroid-collection@example.com');
    const connectionId = await connectVroid(cookie);
    route('GET', `${VROID}/api/character_models/model-2`, () =>
      reply({ data: { character_model: vroidModel('model-2', 'vroid-user-1', 'Ren') } }),
    );
    type W = { selected: { avatarId: string } | null; collection: { avatarId: string; name: string }[] };
    const read = async (res: Response) => {
      expect(res.status).toBe(200);
      return (await res.json()) as W;
    };

    // Saving does not change what is worn.
    let wallet = await read(await post('/api/account/avatar/collect', cookie, { connectionId, avatarId: 'model-2' }));
    expect(wallet.selected).toBeNull();
    expect(wallet.collection.map((a) => a.avatarId)).toEqual(['model-2']);

    wallet = await read(await selectVroidModel(cookie, connectionId));
    expect(wallet.selected?.avatarId).toBe('model-1');
    expect(wallet.collection.map((a) => a.avatarId)).toEqual(['model-2', 'model-1']);

    // Switching keeps both; saving or wearing again does not duplicate.
    wallet = await read(await post('/api/account/avatar/select', cookie, { connectionId, avatarId: 'model-2' }));
    expect(wallet.selected?.avatarId).toBe('model-2');
    wallet = await read(await post('/api/account/avatar/collect', cookie, { connectionId, avatarId: 'model-2' }));
    expect(wallet.selected?.avatarId).toBe('model-2');
    expect(wallet.collection).toHaveLength(2);
    const selectedRows = await env.DB.prepare('select count(*) as n from avatar where user_id = ? and selected = 1').bind(user.id).first<{ n: number }>();
    expect(selectedRows!.n).toBe(1);

    // Removing one that is not worn leaves the selection alone.
    wallet = await read(await post('/api/account/avatar/remove', cookie, { connectionId, avatarId: 'model-1' }));
    expect(wallet.selected?.avatarId).toBe('model-2');
    expect(wallet.collection.map((a) => a.avatarId)).toEqual(['model-2']);

    // Removing the worn one falls back to no character.
    const ticket = await ticketFor(cookie);
    wallet = await read(await post('/api/account/avatar/remove', cookie, { connectionId, avatarId: 'model-2' }));
    expect(wallet.selected).toBeNull();
    expect(wallet.collection).toEqual([]);
    expect(await (await resolveFromWorld(ticket)).json()).toEqual({ avatar: null });

    // Other users' collections are out of reach.
    await selectVroidModel(cookie, connectionId);
    const other = await signedInUser('vroid-collection-other@example.com');
    await read(await post('/api/account/avatar/remove', other.cookie, { connectionId, avatarId: 'model-1' }));
    const kept = await env.DB.prepare('select count(*) as n from avatar where user_id = ?').bind(user.id).first<{ n: number }>();
    expect(kept!.n).toBe(1);
    expect((await post('/api/account/avatar/collect', other.cookie, { connectionId, avatarId: 'model-1' })).status).toBe(404);
    }, 20_000);

  // Many real D1 round trips: more than the default 5 s on a slow machine.
  it('renames a saved character for its owner only, across re-saves and in worlds', { timeout: 15_000 }, async () => {
    const { cookie } = await signedInUser('vroid-rename@example.com');
    const connectionId = await connectVroid(cookie);
    await selectVroidModel(cookie, connectionId);
    const rename = (name: unknown, who = cookie) => post('/api/account/avatar/rename', who, { connectionId, avatarId: 'model-1', name });
    type W = { selected: { name: string } | null; collection: { name: string }[] };

    let res = await rename('  Blue   Knight ');
    expect(res.status).toBe(200);
    expect(((await res.json()) as W).collection[0].name).toBe('Blue Knight');

    // Wearing it again refreshes the platform details but keeps the chosen name.
    const wallet = (await (await selectVroidModel(cookie, connectionId)).json()) as W;
    expect(wallet.selected?.name).toBe('Blue Knight');
    stubDownload();
    const resolved = (await (await resolveFromWorld(await ticketFor(cookie))).json()) as { avatar: { name: string } };
    expect(resolved.avatar.name).toBe('Blue Knight');

    expect((await rename('x'.repeat(65))).status).toBe(400);
    expect((await rename(42)).status).toBe(400);
    const other = await signedInUser('vroid-rename-other@example.com');
    expect((await rename('Stolen', other.cookie)).status).toBe(404);

    // Empty goes back to the platform's name.
    res = await rename('');
    expect(((await res.json()) as W).collection[0].name).toBe('Aoi');
  });

  it('resolves for a world on another origin: provider URL, no credentials, no cookies', async () => {
    const { cookie } = await signedInUser('vroid-resolve@example.com');
    const connectionId = await connectVroid(cookie);
    await selectVroidModel(cookie, connectionId);
    const ticket = await ticketFor(cookie);

    const preflight = await worker.fetch(
      new Request(`${ORIGIN}/api/account/avatar/resolve`, { method: 'OPTIONS', headers: { Origin: WORLD } }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

    stubDownload();
    const res = await resolveFromWorld(ticket);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      avatar: {
        provider: 'vroid',
        avatarId: 'model-1',
        name: 'Aoi',
        thumbnail: 'https://vroid-hub.pximg.net/images/model-1/sq300.png',
        format: 'vrm',
        modelUrl: S3_URL,
        expiresAt: '2026-10-01T00:00:00Z',
        sourceUrl: `${VROID}/characters/char-model-1/models/model-1`,
        // VRoid's license does not allow showing it to other players.
        share: null,
      },
    });
    for (const secret of ['vroid-access', 'vroid-refresh', 'vroid-client-secret', 'vroid-user-1', 'vroid-resolve@example.com']) {
      expect(text).not.toContain(secret);
    }
    // The model itself was never fetched by the Worker.
    expect(calls.map((c) => new URL(c.url).hostname)).not.toContain('vroid-hub.s3.ap-northeast-1.amazonaws.com');
  });

  it('refreshes an expired access token before loading', async () => {
    const { user, cookie } = await signedInUser('vroid-refresh@example.com');
    const connectionId = await connectVroid(cookie);
    await selectVroidModel(cookie, connectionId);
    const expired = await seal(AVATAR_SECRET, 'provider-token-v1', connectionId, {
      access: 'vroid-access-old',
      refresh: 'vroid-refresh-1',
      expiresAt: Date.now() - 1000,
    });
    await env.DB.prepare('update avatar_connection set token_enc = ? where id = ?').bind(expired, connectionId).run();

    route('POST', `${VROID}/oauth/token`, async (request) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('vroid-refresh-1');
      return reply({ access_token: 'vroid-access-2', refresh_token: 'vroid-refresh-2', expires_in: 3600 });
    });
    stubDownload('vroid-access-2');
    const res = await resolveFromWorld(await ticketFor(cookie));
    expect(((await res.json()) as { avatar: { modelUrl: string } }).avatar.modelUrl).toBe(S3_URL);
    const row = await env.DB.prepare('select token_enc from avatar_connection where user_id = ?').bind(user.id).first<{ token_enc: string }>();
    expect(row!.token_enc).not.toBe(expired);
  });

  it('falls back to no avatar and asks to reconnect when VRoid refuses the refresh', async () => {
    const { cookie } = await signedInUser('vroid-revoked@example.com');
    const connectionId = await connectVroid(cookie);
    await selectVroidModel(cookie, connectionId);
    const expired = await seal(AVATAR_SECRET, 'provider-token-v1', connectionId, { access: 'a', refresh: 'r', expiresAt: 0 });
    await env.DB.prepare('update avatar_connection set token_enc = ? where id = ?').bind(expired, connectionId).run();
    route('POST', `${VROID}/oauth/token`, () => reply({ error: 'invalid_grant' }, 400));

    const res = await resolveFromWorld(await ticketFor(cookie));
    expect(await res.json()).toEqual({ avatar: null });
    const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as {
      connections: { status: string }[];
    };
    expect(wallet.connections[0].status).toBe('reconnect');
  });

  it('"Continue without character" and disconnecting both stop resolution at once', async () => {
    const { user, cookie } = await signedInUser('vroid-none@example.com');
    const connectionId = await connectVroid(cookie);
    await selectVroidModel(cookie, connectionId);
    const ticket = await ticketFor(cookie);

    const cleared = await post('/api/account/avatar/select', cookie, { avatarId: null });
    const clearedWallet = (await cleared.json()) as { selected: unknown; collection: unknown[] };
    expect(clearedWallet.selected).toBeNull();
    // The character stays in the collection, ready to wear again.
    expect(clearedWallet.collection).toHaveLength(1);
    expect(await (await resolveFromWorld(ticket)).json()).toEqual({ avatar: null });

    await selectVroidModel(cookie, connectionId);
    route('POST', `${VROID}/oauth/revoke`, () => reply({}));
    const res = await post('/api/account/avatar/disconnect', cookie, { connectionId });
    expect(((await res.json()) as { connections: unknown[] }).connections).toEqual([]);
    expect(await (await resolveFromWorld(ticket)).json()).toEqual({ avatar: null });
    const left = await env.DB.prepare('select count(*) as n from avatar where user_id = ?').bind(user.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(calls.some((c) => c.url === `${VROID}/oauth/revoke`)).toBe(true);
  });
});

describe('handoff tickets', () => {
  it('require a session to mint, and refuse forged, tampered or expired ones', async () => {
    expect((await post('/api/account/avatar/handoff', null, {})).status).toBe(401);
    const { cookie } = await signedInUser('ticket@example.com');
    const ticket = await ticketFor(cookie);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Opaque: the user id is not readable from it.
    expect(new TextDecoder().decode(fromBase64url(ticket.split('.')[1]))).not.toContain('ticket@example.com');

    const tampered = ticket.slice(0, -2) + (ticket.endsWith('A') ? 'BB' : 'AA');
    for (const bad of ['nope', tampered, 42, '']) {
      expect((await resolveFromWorld(bad)).status).toBe(401);
    }
    const expired = await seal(AVATAR_SECRET, 'handoff-v1', 'avatar-handoff', { u: 'someone', exp: 1 });
    expect((await resolveFromWorld(expired)).status).toBe(401);
    // Sealed for another purpose, e.g. a stored provider token.
    const wrongPurpose = await seal(AVATAR_SECRET, 'provider-token-v1', 'avatar-handoff', { u: 'someone', exp: 9e9 });
    expect((await resolveFromWorld(wrongPurpose)).status).toBe(401);
  });

  it('resolve to nothing when no avatar is selected', async () => {
    const { cookie } = await signedInUser('ticket-none@example.com');
    expect(await (await resolveFromWorld(await ticketFor(cookie))).json()).toEqual({ avatar: null });
  });
});

// ── AT Protocol / at3d ───────────────────────────────────────────────────────

function stubIdentity(pds = PDS) {
  route('GET', 'https://cloudflare-dns.com/dns-query', (request) => {
    expect(new URL(request.url).searchParams.get('name')).toBe(`_atproto.${HANDLE}`);
    return reply({ Status: 0, Answer: [{ name: `_atproto.${HANDLE}`, type: 16, data: `"did=${DID}"` }] });
  });
  route('GET', `https://plc.directory/${DID}`, () =>
    reply({
      id: DID,
      alsoKnownAs: [`at://${HANDLE}`],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
    }),
  );
}

function stubAuthorizationServer() {
  route('GET', `${PDS}/.well-known/oauth-protected-resource`, () => reply({ resource: PDS, authorization_servers: [AS] }));
  route('GET', `${AS}/.well-known/oauth-authorization-server`, () =>
    reply({
      issuer: AS,
      authorization_endpoint: `${AS}/oauth/authorize`,
      token_endpoint: `${AS}/oauth/token`,
      pushed_authorization_request_endpoint: `${AS}/oauth/par`,
      revocation_endpoint: `${AS}/oauth/revoke`,
      authorization_response_iss_parameter_supported: true,
      require_pushed_authorization_requests: true,
      scopes_supported: ['atproto', 'transition:generic'],
      dpop_signing_alg_values_supported: ['ES256'],
    }),
  );
}

/** Checks a DPoP proof's signature against its embedded key, and returns its payload. */
async function verifyDpop(request: Request): Promise<Record<string, unknown>> {
  const proof = request.headers.get('DPoP')!;
  const [header, payload, signature] = proof.split('.');
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  const { jwk, alg, typ } = decode(header);
  expect({ alg, typ }).toEqual({ alg: 'ES256', typ: 'dpop+jwt' });
  expect(jwk.d).toBeUndefined();
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
  return decode(payload);
}

async function startAtproto(cookie: string) {
  stubIdentity();
  stubAuthorizationServer();
  let parCalls = 0;
  route('POST', `${AS}/oauth/par`, async (request) => {
    parCalls++;
    const proof = await verifyDpop(request);
    expect(proof).toMatchObject({ htm: 'POST', htu: `${AS}/oauth/par` });
    if (!proof.nonce) return reply({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'nonce-1' });
    expect(proof.nonce).toBe('nonce-1');
    const form = new URLSearchParams(await request.text());
    expect(Object.fromEntries(form)).toMatchObject({
      client_id: `${ORIGIN}/api/account/avatar/atproto/client-metadata.json`,
      response_type: 'code',
      code_challenge_method: 'S256',
      redirect_uri: `${ORIGIN}/api/account/avatar/callback/atproto`,
      scope: 'atproto',
      login_hint: HANDLE,
    });
    return reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 300 }, 201, { 'DPoP-Nonce': 'nonce-2' });
  });
  const start = await post('/api/account/avatar/connect/atproto', cookie, { handle: `@${HANDLE}` });
  expect(start.status).toBe(200);
  expect(parCalls).toBe(2);
  const url = new URL(((await start.json()) as { url: string }).url);
  expect(url.origin + url.pathname).toBe(`${AS}/oauth/authorize`);
  expect(url.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:req-1');
  const flow = cookieValue(start, FLOW_COOKIE);
  // The DPoP private key rides in the flow cookie, sealed.
  expect(decodeURIComponent(flow)).not.toMatch(/"d"/);
  return { flow };
}

async function finishAtproto(cookie: string, flow: string, state: string, token: Record<string, unknown>, iss = AS) {
  route('POST', `${AS}/oauth/token`, async (request) => {
    const proof = await verifyDpop(request);
    expect(proof).toMatchObject({ htm: 'POST', htu: `${AS}/oauth/token`, nonce: 'nonce-2' });
    const form = new URLSearchParams(await request.text());
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    return reply(token);
  });
  route('POST', `${AS}/oauth/revoke`, () => new Response(null, { status: 200 }));
  return call(`/api/account/avatar/callback/atproto?code=code-1&state=${state}&iss=${encodeURIComponent(iss)}`, {
    headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${flow}` },
  });
}

async function flowState(flow: string): Promise<string> {
  // The state is inside the sealed cookie; read it the way the callback does.
  const { open } = await import('../src/avatars/crypto');
  const value = await open<{ state: string }>(AVATAR_SECRET, 'oauth-flow-v1', 'flow', flow);
  return value!.state;
}

const GOOD_TOKEN = {
  access_token: 'at-access',
  refresh_token: 'at-refresh',
  token_type: 'DPoP',
  sub: DID,
  scope: 'atproto',
  expires_in: 3600,
};

describe('at3d / AT Protocol', () => {
  it('publishes OAuth client metadata for a public DPoP client', async () => {
    const res = await call('/api/account/avatar/atproto/client-metadata.json');
    expect(await res.json()).toEqual({
      client_id: `${ORIGIN}/api/account/avatar/atproto/client-metadata.json`,
      client_name: 'WorldMesh',
      client_uri: ORIGIN,
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [`${ORIGIN}/api/account/avatar/callback/atproto`, `${ORIGIN}/api/auth/atproto/callback`],
      scope: CLIENT_SCOPE,
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
    });
    expect(atprotoClientId('http://127.0.0.1:5170', 'http://127.0.0.1:5170/api/account/avatar/callback/atproto')).toBe(
      `http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A5170%2Fapi%2Faccount%2Favatar%2Fcallback%2Fatproto&scope=${encodeURIComponent(CLIENT_SCOPE).replace(/%20/g, '+')}`,
    );
    expect(() => atprotoClientId('http://localhost:5170', 'x')).toThrow(/127\.0\.0\.1/);
  });

  it('proves the DID with PAR + DPoP, then keeps no tokens', async () => {
    const { user, cookie } = await signedInUser('at-connect@example.com');
    const { flow } = await startAtproto(cookie);
    const res = await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected`);
    const row = await env.DB.prepare('select * from avatar_connection where user_id = ?').bind(user.id).first();
    expect(row).toMatchObject({
      provider: 'atproto',
      provider_account_id: DID,
      display_name: HANDLE,
      service_endpoint: PDS,
      token_enc: null,
    });
    // The tokens were handed back.
    const revoke = calls.find((c) => c.url === `${AS}/oauth/revoke`);
    expect(new URLSearchParams(await revoke!.text()).get('token')).toBe('at-refresh');
  });

  it('refuses a response from another issuer, or for another account', async () => {
    const { user, cookie } = await signedInUser('at-mismatch@example.com');
    const first = await startAtproto(cookie);
    const wrongIss = await finishAtproto(cookie, first.flow, await flowState(first.flow), GOOD_TOKEN, 'https://evil-as.pds-fixture.net');
    expect(wrongIss.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);

    const second = await startAtproto(cookie);
    const otherAccount = await finishAtproto(cookie, second.flow, await flowState(second.flow), {
      ...GOOD_TOKEN,
      sub: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect(otherAccount.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);
    const rows = await env.DB.prepare('select count(*) as n from avatar_connection where user_id = ?').bind(user.id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('never fetches private or non-https hosts named in identity documents', async () => {
    const { cookie } = await signedInUser('at-ssrf@example.com');
    stubIdentity('https://10.0.0.1');
    const res = await post('/api/account/avatar/connect/atproto', cookie, { handle: HANDLE });
    expect(res.status).toBe(400);
    expect(calls.some((c) => new URL(c.url).hostname === '10.0.0.1')).toBe(false);

    const bad = await post('/api/account/avatar/connect/atproto', cookie, { handle: 'not a handle' });
    expect(bad.status).toBe(400);
  });

  it('asks the connected account for upload permission and hands it to the browser, never storing it', async () => {
    const { user, cookie } = await signedInUser('at-upload@example.com');
    // Upload needs a connected at3d account first.
    expect((await post('/api/account/avatar/connect/atproto', cookie, { upload: true })).status).toBe(404);
    const first = await startAtproto(cookie);
    await finishAtproto(cookie, first.flow, await flowState(first.flow), GOOD_TOKEN);

    route('POST', `${AS}/oauth/par`, async (request) => {
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      // Only what an upload needs, for the account already connected.
      expect(form).toMatchObject({ scope: UPLOAD_SCOPE, login_hint: HANDLE });
      return reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-2' }, 201, { 'DPoP-Nonce': 'nonce-2' });
    });
    const start = await post('/api/account/avatar/connect/atproto', cookie, { upload: true, handle: 'someone.else.net' });
    expect(start.status).toBe(200);
    const flow = cookieValue(start, FLOW_COOKIE);

    const revokesBefore = calls.filter((c) => c.url === `${AS}/oauth/revoke`).length;
    const callback = await finishAtproto(cookie, flow, await flowState(flow), { ...GOOD_TOKEN, scope: UPLOAD_SCOPE });
    expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=upload&provider=atproto`);
    // Not revoked yet: the browser still needs it.
    expect(calls.filter((c) => c.url === `${AS}/oauth/revoke`).length).toBe(revokesBefore);
    const sealed = cookieValue(callback, UPLOAD_COOKIE);
    expect(decodeURIComponent(sealed)).not.toContain('at-access');
    const row = await env.DB.prepare('select token_enc from avatar_connection where user_id = ?').bind(user.id).first<{ token_enc: null }>();
    expect(row!.token_enc).toBeNull();

    const withGrant = `${cookie}; ${UPLOAD_COOKIE}=${sealed}`;
    const grant = (await (await post('/api/account/avatar/upload/grant', withGrant, {})).json()) as Record<string, unknown>;
    expect(grant).toMatchObject({ provider: 'atproto', service: PDS, account: DID, accessToken: 'at-access' });
    expect((grant.dpopKey as JsonWebKey).d).toBeTruthy();
    expect(grant).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(grant)).not.toContain('at-refresh');

    // Bound to the user who authorized it.
    const other = await signedInUser('at-upload-other@example.com');
    expect((await post('/api/account/avatar/upload/grant', `${other.cookie}; ${UPLOAD_COOKIE}=${sealed}`, {})).status).toBe(410);

    const done = await post('/api/account/avatar/upload/done', withGrant, {});
    expect(done.status).toBe(200);
    expect(cookieValue(done, UPLOAD_COOKIE)).toBe('');
    await vi.waitFor(() => expect(calls.filter((c) => c.url === `${AS}/oauth/revoke`).length).toBe(revokesBefore + 2));
    const revoked = await Promise.all(calls.filter((c) => c.url === `${AS}/oauth/revoke`).slice(-2).map(async (c) => new URLSearchParams(await c.text()).get('token')));
    expect(revoked).toEqual(['at-refresh', 'at-access']);
  });

  it('refuses an upload grant without permission to create avatars', async () => {
    const { cookie } = await signedInUser('at-upload-scope@example.com');
    const first = await startAtproto(cookie);
    await finishAtproto(cookie, first.flow, await flowState(first.flow), GOOD_TOKEN);
    route('POST', `${AS}/oauth/par`, () => reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-3' }, 201, { 'DPoP-Nonce': 'nonce-2' }));
    const flow = cookieValue(await post('/api/account/avatar/connect/atproto', cookie, { upload: true }), FLOW_COOKIE);
    const callback = await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${UPLOAD_COOKIE}=`))).toBe(false);
  });

  it('lists renderable app.at3d.avatar records and resolves to the PDS blob', async () => {
    const { cookie } = await signedInUser('at-list@example.com');
    const { flow } = await startAtproto(cookie);
    await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as {
      connections: { id: string }[];
    };
    const connectionId = wallet.connections[0].id;

    const vrmRecord = {
      uri: `at://${DID}/app.at3d.avatar/3kabc`,
      cid: 'bafyreirecord',
      value: {
        $type: 'app.at3d.avatar',
        name: 'Sky',
        format: 'vrm',
        appearance: {
          $type: 'app.at3d.avatar#vrmAppearance',
          model: { $type: 'blob', ref: { $link: 'bafkreimodelcid' }, mimeType: 'application/octet-stream', size: 1000 },
          vrmVersion: '1.0',
        },
        thumbnail: { $type: 'blob', ref: { $link: 'bafkreithumbcid' }, mimeType: 'image/png', size: 100 },
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    };
    const parametric = {
      uri: `at://${DID}/app.at3d.avatar/3kdef`,
      value: { format: 'parametric', appearance: { system: 'rfc-v1' } },
    };
    route('GET', `${PDS}/xrpc/com.atproto.repo.listRecords`, (request) => {
      const q = new URL(request.url).searchParams;
      expect(q.get('repo')).toBe(DID);
      expect(q.get('collection')).toBe('app.at3d.avatar');
      return reply({ records: [vrmRecord, parametric] });
    });
    const list = (await (await call(`/api/account/avatar/connections/${connectionId}/avatars`, { headers: { Cookie: cookie } })).json()) as {
      avatars: { id: string }[];
    };
    expect(list.avatars).toEqual([
      {
        id: vrmRecord.uri,
        name: 'Sky',
        thumbnail: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafkreithumbcid`,
        format: 'vrm',
        metadata: { modelCid: 'bafkreimodelcid', vrmVersion: '1.0' },
      },
    ]);

    route('GET', `${PDS}/xrpc/com.atproto.repo.getRecord`, () => reply(vrmRecord));
    expect((await post('/api/account/avatar/select', cookie, { connectionId, avatarId: vrmRecord.uri })).status).toBe(200);
    // A record in someone else's repo cannot be selected through this connection.
    const foreign = `at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/app.at3d.avatar/3kabc`;
    expect((await post('/api/account/avatar/select', cookie, { connectionId, avatarId: foreign })).status).toBe(404);

    const res = await resolveFromWorld(await ticketFor(cookie));
    expect(await res.json()).toEqual({
      avatar: {
        provider: 'atproto',
        avatarId: vrmRecord.uri,
        name: 'Sky',
        thumbnail: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafkreithumbcid`,
        format: 'vrm',
        modelUrl: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafkreimodelcid`,
        expiresAt: null,
        sourceUrl: null,
        // A PDS that is not one of Bluesky's hosts could be anyone's server: not signed for other players.
        share: null,
      },
    });
  });
});

// ── Sketchfab ────────────────────────────────────────────────────────────────

function sketchfabModel(uid: string, ownerUid: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    uid,
    name,
    viewerUrl: `${SKETCHFAB}/3d-models/${name.toLowerCase()}-${uid}`,
    animationCount: 2,
    isPrivate: false,
    user: { uid: ownerUid, username: 'mesh-maker' },
    thumbnails: {
      images: [
        { url: `https://media.sketchfab.com/models/${uid}/thumbnails/big.jpeg`, width: 1920 },
        { url: `https://media.sketchfab.com/models/${uid}/thumbnails/small.jpeg`, width: 200 },
        { url: `https://media.sketchfab.com/models/${uid}/thumbnails/medium.jpeg`, width: 720 },
      ],
    },
    archives: { glb: { size: 4_000_000 }, gltf: { size: 3_000_000 } },
    ...extra,
  };
}

async function connectSketchfab(cookie: string) {
  const start = await post('/api/account/avatar/connect/sketchfab', cookie, {});
  expect(start.status).toBe(200);
  const authorize = new URL(((await start.json()) as { url: string }).url);
  const flow = cookieValue(start, FLOW_COOKIE);

  let verifier = '';
  route('POST', `${SKETCHFAB}/oauth2/token/`, async (request) => {
    const form = new URLSearchParams(await request.text());
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('sf-code');
    expect(form.get('client_id')).toBe('sketchfab-client');
    expect(form.get('client_secret')).toBe('sketchfab-client-secret');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/account/avatar/callback/sketchfab`);
    verifier = form.get('code_verifier') ?? '';
    return reply({ access_token: 'sf-access-1', refresh_token: 'sf-refresh-1', token_type: 'Bearer', expires_in: 2592000 });
  });
  route('GET', `${SKETCHFAB_API}/v3/me`, (request) => {
    expect(request.headers.get('Authorization')).toBe('Bearer sf-access-1');
    return reply({ uid: SKETCHFAB_USER, username: 'mesh-maker', displayName: 'Mesh Maker' });
  });
  const callback = await call(
    `/api/account/avatar/callback/sketchfab?code=sf-code&state=${authorize.searchParams.get('state')}`,
    { headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${flow}` } },
  );
  expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected`);
  expect(await pkceChallenge(verifier)).toBe(authorize.searchParams.get('code_challenge'));
  const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as {
    connections: { id: string; provider: string; displayName: string }[];
  };
  const connection = wallet.connections.find((c) => c.provider === 'sketchfab')!;
  expect(connection.displayName).toBe('Mesh Maker');
  return connection.id;
}

async function selectSketchfabModel(cookie: string, connectionId: string) {
  route('GET', `${SKETCHFAB_API}/v3/models/${SKETCHFAB_MODEL}`, () => reply(sketchfabModel(SKETCHFAB_MODEL, SKETCHFAB_USER, 'Robo')));
  const res = await post('/api/account/avatar/select', cookie, { connectionId, avatarId: SKETCHFAB_MODEL });
  expect(res.status).toBe(200);
}

describe('Sketchfab', () => {
  it('starts the authorization code flow with PKCE', async () => {
    const { cookie } = await signedInUser('sf-start@example.com');
    const res = await post('/api/account/avatar/connect/sketchfab', cookie, {});
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${SKETCHFAB}/oauth2/authorize/`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'sketchfab-client',
      redirect_uri: `${ORIGIN}/api/account/avatar/callback/sketchfab`,
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('connects, keeping tokens only in encrypted form', async () => {
    const { user, cookie } = await signedInUser('sf-connect@example.com');
    await connectSketchfab(cookie);
    const row = await env.DB.prepare('select * from avatar_connection where user_id = ?').bind(user.id).first<Record<string, string>>();
    expect(row).toMatchObject({ provider: 'sketchfab', provider_account_id: SKETCHFAB_USER, status: 'active' });
    expect(row!.token_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('sf-access-1');
    expect(JSON.stringify(row)).not.toContain('sf-refresh-1');
  });

  it("lists the user's own GLB models across pages, skipping ones worlds cannot load", async () => {
    const { cookie } = await signedInUser('sf-list@example.com');
    const connectionId = await connectSketchfab(cookie);
    const second = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    route('GET', `${SKETCHFAB_API}/v3/me/models`, (request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('cursor') === 'p2') {
        return reply({ results: [sketchfabModel(second, SKETCHFAB_USER, 'Second')], next: 'https://evil.example.org/v3/me/models?cursor=p3' });
      }
      return reply({
        results: [
          sketchfabModel(SKETCHFAB_MODEL, SKETCHFAB_USER, 'Robo'),
          sketchfabModel('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', SKETCHFAB_USER, 'NoGlb', { archives: { gltf: { size: 1 } } }),
          sketchfabModel('cccccccccccccccccccccccccccccccc', SKETCHFAB_USER, 'Busy', { status: { processing: 'PROCESSING' } }),
          sketchfabModel('not-a-uid', SKETCHFAB_USER, 'Bad'),
        ],
        next: `${SKETCHFAB_API}/v3/me/models?count=24&cursor=p2`,
      });
    });
    const list = await call(`/api/account/avatar/connections/${connectionId}/avatars`, { headers: { Cookie: cookie } });
    const { avatars } = (await list.json()) as { avatars: { id: string }[] };
    expect(avatars).toEqual([
      {
        id: SKETCHFAB_MODEL,
        name: 'Robo',
        thumbnail: `https://media.sketchfab.com/models/${SKETCHFAB_MODEL}/thumbnails/medium.jpeg`,
        format: 'glb',
        metadata: { viewerUrl: `${SKETCHFAB}/3d-models/robo-${SKETCHFAB_MODEL}`, animationCount: 2, glbBytes: 4_000_000, private: false },
      },
      expect.objectContaining({ id: second, name: 'Second' }),
    ]);
    // The foreign `next` link on page two was not followed.
    expect(calls.map((c) => new URL(c.url).hostname)).not.toContain('evil.example.org');
  });

  it('authorizes uploads separately, for the connected account only, and revokes them after', async () => {
    const { user, cookie } = await signedInUser('sf-upload@example.com');
    await connectSketchfab(cookie);
    const storedBefore = await env.DB.prepare('select token_enc from avatar_connection where user_id = ?').bind(user.id).first<{ token_enc: string }>();

    const upload = async (who: { uid: string }) => {
      const start = await post('/api/account/avatar/connect/sketchfab', cookie, { upload: true });
      expect(start.status).toBe(200);
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state');
      route('POST', `${SKETCHFAB}/oauth2/token/`, () =>
        reply({ access_token: 'sf-upload-access', refresh_token: 'sf-upload-refresh', token_type: 'Bearer', expires_in: 2592000 }),
      );
      route('GET', `${SKETCHFAB_API}/v3/me`, () => reply({ uid: who.uid, username: 'mesh-maker' }));
      route('POST', `${SKETCHFAB}/oauth2/revoke_token/`, () => reply({}));
      return call(`/api/account/avatar/callback/sketchfab?code=sf-code-2&state=${state}`, {
        headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${cookieValue(start, FLOW_COOKIE)}` },
      });
    };

    // Approved as a different Sketchfab account: refused, and that grant is given back.
    const wrong = await upload({ uid: 'ffffffffffffffffffffffffffffffff' });
    expect(wrong.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error&reason=other-account`);
    expect(wrong.headers.getSetCookie().some((c) => c.startsWith(`${UPLOAD_COOKIE}=`))).toBe(false);
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${SKETCHFAB}/oauth2/revoke_token/`)).toBe(true));

    const callback = await upload({ uid: SKETCHFAB_USER });
    expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=upload&provider=sketchfab`);
    // The connection's own tokens are untouched.
    const storedAfter = await env.DB.prepare('select token_enc from avatar_connection where user_id = ?').bind(user.id).first<{ token_enc: string }>();
    expect(storedAfter!.token_enc).toBe(storedBefore!.token_enc);

    const withGrant = `${cookie}; ${UPLOAD_COOKIE}=${cookieValue(callback, UPLOAD_COOKIE)}`;
    const grant = (await (await post('/api/account/avatar/upload/grant', withGrant, {})).json()) as Record<string, unknown>;
    expect(grant).toMatchObject({ provider: 'sketchfab', service: SKETCHFAB_API, account: SKETCHFAB_USER, accessToken: 'sf-upload-access' });
    expect(JSON.stringify(grant)).not.toContain('sf-upload-refresh');

    const before = calls.length;
    expect((await post('/api/account/avatar/upload/done', withGrant, {})).status).toBe(200);
    await vi.waitFor(() => expect(calls.slice(before).filter((c) => c.url === `${SKETCHFAB}/oauth2/revoke_token/`)).toHaveLength(2));
    const revoked = await Promise.all(
      calls.slice(before).filter((c) => c.url === `${SKETCHFAB}/oauth2/revoke_token/`).map(async (c) => new URLSearchParams(await c.text()).get('token')),
    );
    expect(revoked).toEqual(['sf-upload-access', 'sf-upload-refresh']);
  });

  it("selects only the user's own models", async () => {
    const { cookie } = await signedInUser('sf-select@example.com');
    const connectionId = await connectSketchfab(cookie);
    await selectSketchfabModel(cookie, connectionId);
    const other = 'dddddddddddddddddddddddddddddddd';
    route('GET', `${SKETCHFAB_API}/v3/models/${other}`, () => reply(sketchfabModel(other, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'Theirs')));
    expect((await post('/api/account/avatar/select', cookie, { connectionId, avatarId: other })).status).toBe(404);
    expect((await post('/api/account/avatar/select', cookie, { connectionId, avatarId: '../v3/me' })).status).toBe(404);
  });

  it('resolves to the presigned GLB URL without exposing credentials', async () => {
    const { cookie } = await signedInUser('sf-resolve@example.com');
    const connectionId = await connectSketchfab(cookie);
    await selectSketchfabModel(cookie, connectionId);
    route('GET', `${SKETCHFAB_API}/v3/models/${SKETCHFAB_MODEL}/download`, (request) => {
      expect(request.headers.get('Authorization')).toBe('Bearer sf-access-1');
      return reply({
        gltf: { url: 'https://sketchfab-prod-media.s3.amazonaws.com/archives/model.zip', size: 3_000_000, expires: 300 },
        glb: { url: SKETCHFAB_GLB, size: 4_000_000, expires: 300 },
      });
    });
    const before = Date.now();
    const res = await resolveFromWorld(await ticketFor(cookie));
    const text = await res.text();
    const { avatar } = JSON.parse(text) as { avatar: Record<string, string> };
    expect(avatar).toMatchObject({
      provider: 'sketchfab',
      avatarId: SKETCHFAB_MODEL,
      name: 'Robo',
      format: 'glb',
      modelUrl: SKETCHFAB_GLB,
      sourceUrl: `${SKETCHFAB}/3d-models/robo-${SKETCHFAB_MODEL}`,
    });
    const expires = Date.parse(avatar.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 299_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 300_000);
    for (const secret of ['sf-access', 'sf-refresh', 'sketchfab-client-secret', SKETCHFAB_USER, 'sf-resolve@example.com']) {
      expect(text).not.toContain(secret);
    }

    // Signed for other players, until the link itself runs out, and checkable with the public key.
    const share = (avatar as unknown as { share: SignedShare }).share;
    expect(share).toMatchObject({ u: SKETCHFAB_GLB, f: 'glb' });
    expect(share.i).toMatch(/^[0-9a-f]{16}$/);
    expect(share.x).toBe(Math.floor(expires / 1000));
    const keyRes = await worker.fetch(new Request(`${ORIGIN}/api/account/avatar/resolve`, { headers: { Origin: WORLD } }), env);
    expect(keyRes.status).toBe(200);
    expect(keyRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const { key } = (await keyRes.json()) as { key: JsonWebKey };
    expect(key).toEqual({ kty: 'OKP', crv: 'Ed25519', x: expect.any(String) });
    const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'Ed25519' }, false, ['verify']);
    const payload = sharePayload(share.u, share.f, share.i, share.x);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromBase64url(share.s), payload)).toBe(true);
    const forged = sharePayload('https://evil.example/model.glb', share.f, share.i, share.x);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromBase64url(share.s), forged)).toBe(false);
    expect(calls.map((c) => new URL(c.url).hostname)).not.toContain('sketchfab-prod-media.s3.amazonaws.com');
  });

  it('falls back to no avatar when there is no GLB, and asks to reconnect on a refused token', async () => {
    const { cookie } = await signedInUser('sf-fallback@example.com');
    const connectionId = await connectSketchfab(cookie);
    await selectSketchfabModel(cookie, connectionId);
    const ticket = await ticketFor(cookie);

    route('GET', `${SKETCHFAB_API}/v3/models/${SKETCHFAB_MODEL}/download`, () => reply({ gltf: { url: 'https://x.example.org/a.zip', expires: 300 } }));
    expect(await (await resolveFromWorld(ticket)).json()).toEqual({ avatar: null });

    route('GET', `${SKETCHFAB_API}/v3/models/${SKETCHFAB_MODEL}/download`, () => reply({ detail: 'Invalid token' }, 401));
    expect(await (await resolveFromWorld(ticket)).json()).toEqual({ avatar: null });
    const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as {
      connections: { status: string }[];
    };
    expect(wallet.connections[0].status).toBe('reconnect');
  });

  it('refreshes an expiring token, and revokes it on disconnect', async () => {
    const { cookie } = await signedInUser('sf-refresh@example.com');
    const connectionId = await connectSketchfab(cookie);
    const expiring = await seal(AVATAR_SECRET, 'provider-token-v1', connectionId, {
      access: 'sf-access-old',
      refresh: 'sf-refresh-1',
      expiresAt: Date.now() + 1000,
    });
    await env.DB.prepare('update avatar_connection set token_enc = ? where id = ?').bind(expiring, connectionId).run();
    route('POST', `${SKETCHFAB}/oauth2/token/`, async (request) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('sf-refresh-1');
      return reply({ access_token: 'sf-access-2', expires_in: 2592000 });
    });
    route('GET', `${SKETCHFAB_API}/v3/me/models`, (request) => {
      expect(request.headers.get('Authorization')).toBe('Bearer sf-access-2');
      return reply({ results: [], next: null });
    });
    const list = await call(`/api/account/avatar/connections/${connectionId}/avatars`, { headers: { Cookie: cookie } });
    expect(await list.json()).toEqual({ avatars: [] });

    route('POST', `${SKETCHFAB}/oauth2/revoke_token/`, async (request) => {
      expect(new URLSearchParams(await request.text()).get('token')).toBe('sf-access-2');
      return reply({});
    });
    const res = await post('/api/account/avatar/disconnect', cookie, { connectionId });
    expect(((await res.json()) as { connections: unknown[] }).connections).toEqual([]);
    expect(calls.some((c) => c.url === `${SKETCHFAB}/oauth2/revoke_token/`)).toBe(true);
  });
});

// ── My buildings ─────────────────────────────────────────────────────────────

interface BuildingList {
  enabled: boolean;
  providers: { id: string; label: string }[];
  connections: { id: string; provider: string; label: string }[];
  buildings: {
    id: string;
    connectionId: string;
    provider: string;
    modelId: string;
    name: string | null;
    bytes: number | null;
    sourceUrl: string | null;
    reachable: boolean;
    worlds: { url: string; status: string; reason: string | null }[];
  }[];
}

async function buildingList(cookie: string): Promise<BuildingList> {
  const res = await call('/api/account/building/list', { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as BuildingList;
}

const BUILDING_MODEL = 'b1d1b1d1b1d1b1d1b1d1b1d1b1d1b1d1';

function buildingRecord(rkey: string, name: string, mimeType = 'model/gltf-binary') {
  return {
    uri: `at://${DID}/net.worldmesh.building/${rkey}`,
    cid: 'bafyreibuilding',
    value: {
      $type: 'net.worldmesh.building',
      name,
      model: { $type: 'blob', ref: { $link: 'bafkreibuildingmodel' }, mimeType, size: 2_500_000 },
      createdAt: '2026-10-19T00:00:00Z',
    },
  };
}

// Each test signs in and connects through several real D1 round trips: more than the default 5 s on a busy machine.
describe('My buildings', { timeout: 15_000 }, () => {
  it('is off until AVATAR_SECRET is set, needs a session, and offers only platforms that hold buildings', async () => {
    const { AVATAR_SECRET: _secret, ...withoutSecret } = env;
    const off = await call('/api/account/building/list', {}, withoutSecret as Env);
    expect(await off.json()).toEqual({ enabled: false, providers: [], connections: [], buildings: [] });
    expect((await call('/api/account/building/list')).status).toBe(401);

    const { cookie } = await signedInUser('buildings-empty@example.com');
    await connectVroid(cookie, 'vroid-building-user');
    const list = await buildingList(cookie);
    expect(list).toEqual({
      enabled: true,
      providers: [
        { id: 'sketchfab', label: 'Sketchfab' },
        { id: 'atproto', label: 'AT Protocol' },
      ],
      // VRoid Hub holds characters only.
      connections: [],
      buildings: [],
    });
    const wallet = (await (await call('/api/account/avatar/wallet', { headers: { Cookie: cookie } })).json()) as { connections: { id: string }[] };
    expect((await call(`/api/account/building/connections/${wallet.connections[0].id}/models`, { headers: { Cookie: cookie } })).status).toBe(400);
    expect((await post('/api/account/building/collect', cookie, { connectionId: 'nope', modelId: 'x' }, 'https://evil.example')).status).toBe(403);
  });

  it("lists the user's own Sketchfab models with their GLB size", async () => {
    const { cookie } = await signedInUser('buildings-sketchfab@example.com');
    const connectionId = await connectSketchfab(cookie);
    route('GET', `${SKETCHFAB_API}/v3/me/models`, () =>
      reply({
        results: [
          sketchfabModel(BUILDING_MODEL, SKETCHFAB_USER, 'Gatehouse', { archives: { glb: { size: 3_200_000 } } }),
          sketchfabModel('c0ffeec0ffeec0ffeec0ffeec0ffee00', SKETCHFAB_USER, 'Processing', { status: { processing: 'PROCESSING' } }),
        ],
        next: null,
      }),
    );
    const models = (await (await call(`/api/account/building/connections/${connectionId}/models`, { headers: { Cookie: cookie } })).json()) as {
      models: unknown[];
    };
    expect(models.models).toEqual([
      {
        id: BUILDING_MODEL,
        name: 'Gatehouse',
        thumbnail: `https://media.sketchfab.com/models/${BUILDING_MODEL}/thumbnails/medium.jpeg`,
        bytes: 3_200_000,
        sourceUrl: `${SKETCHFAB}/3d-models/gatehouse-${BUILDING_MODEL}`,
      },
    ]);
  });

  it('saves only the user\'s own models, once each, and renames and removes them for their owner only', async () => {
    const { cookie } = await signedInUser('buildings-save@example.com');
    const connectionId = await connectSketchfab(cookie);
    route('GET', `${SKETCHFAB_API}/v3/models/${BUILDING_MODEL}`, () => reply(sketchfabModel(BUILDING_MODEL, SKETCHFAB_USER, 'Gatehouse')));
    const saved = (await (await post('/api/account/building/collect', cookie, { connectionId, modelId: BUILDING_MODEL })).json()) as BuildingList;
    expect(saved.connections).toEqual([{ id: connectionId, provider: 'sketchfab', label: 'Sketchfab', displayName: 'Mesh Maker', status: 'active' }]);
    expect(saved.buildings).toHaveLength(1);
    const building = saved.buildings[0];
    expect(building).toMatchObject({ connectionId, provider: 'sketchfab', modelId: BUILDING_MODEL, name: 'Gatehouse', bytes: 4_000_000, reachable: true });
    expect(building.id).toMatch(/^bld_[A-Za-z0-9_-]{16}$/);

    // Saving it again keeps its id, and does not count twice.
    const again = (await (await post('/api/account/building/collect', cookie, { connectionId, modelId: BUILDING_MODEL })).json()) as BuildingList;
    expect(again.buildings.map((b) => b.id)).toEqual([building.id]);

    // Someone else's model is not offered, even if downloadable.
    route('GET', `${SKETCHFAB_API}/v3/models/${SKETCHFAB_MODEL}`, () => reply(sketchfabModel(SKETCHFAB_MODEL, 'ffffffffffffffffffffffffffffffff', 'Not mine')));
    expect((await post('/api/account/building/collect', cookie, { connectionId, modelId: SKETCHFAB_MODEL })).status).toBe(404);

    const renamed = (await (await post('/api/account/building/rename', cookie, { buildingId: building.id, name: '  The   Forest Gate ' })).json()) as BuildingList;
    expect(renamed.buildings[0].name).toBe('The Forest Gate');
    // Only its owner can rename or remove it.
    const other = await signedInUser('buildings-other@example.com');
    expect((await post('/api/account/building/rename', other.cookie, { buildingId: building.id, name: 'Mine now' })).status).toBe(404);
    await post('/api/account/building/remove', other.cookie, { buildingId: building.id });
    expect((await buildingList(cookie)).buildings).toHaveLength(1);

    const removed = (await (await post('/api/account/building/remove', cookie, { buildingId: building.id })).json()) as BuildingList;
    expect(removed.buildings).toEqual([]);
  });

  it('holds at most 20, and lets them go with their platform', async () => {
    const { user, cookie } = await signedInUser('buildings-full@example.com');
    const connectionId = await connectSketchfab(cookie);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 20 }, (_, i) =>
        env.DB.prepare(
          `insert into building (id, user_id, connection_id, provider, external_id, created_at, updated_at) values (?1, ?2, ?3, 'sketchfab', ?4, ?5, ?5)`,
        ).bind(`bld_full${String(i).padStart(12, '0')}`, user.id, connectionId, `model-${i}`, now + i),
      ),
    );
    route('GET', `${SKETCHFAB_API}/v3/models/${BUILDING_MODEL}`, () => reply(sketchfabModel(BUILDING_MODEL, SKETCHFAB_USER, 'Gatehouse')));
    const full = await post('/api/account/building/collect', cookie, { connectionId, modelId: BUILDING_MODEL });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toMatch(/full/);

    route('POST', `${SKETCHFAB}/oauth2/revoke_token/`, () => reply({}));
    expect((await post('/api/account/avatar/disconnect', cookie, { connectionId })).status).toBe(200);
    expect((await buildingList(cookie)).buildings).toEqual([]);
  });

  it('lists net.worldmesh.building records with a GLB, and saves only ones in the account', async () => {
    const { cookie } = await signedInUser('buildings-atproto@example.com');
    const { flow } = await startAtproto(cookie);
    await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    const connectionId = (await buildingList(cookie)).connections[0].id;

    const gate = buildingRecord('3kgate', 'Gate');
    route('GET', `${PDS}/xrpc/com.atproto.repo.listRecords`, (request) => {
      const q = new URL(request.url).searchParams;
      expect(q.get('repo')).toBe(DID);
      expect(q.get('collection')).toBe('net.worldmesh.building');
      return reply({ records: [gate, buildingRecord('3kzip', 'Zipped', 'application/zip')] });
    });
    const models = (await (await call(`/api/account/building/connections/${connectionId}/models`, { headers: { Cookie: cookie } })).json()) as {
      models: unknown[];
    };
    expect(models.models).toEqual([{ id: gate.uri, name: 'Gate', thumbnail: null, bytes: 2_500_000, sourceUrl: null }]);

    route('GET', `${PDS}/xrpc/com.atproto.repo.getRecord`, (request) => {
      expect(new URL(request.url).searchParams.get('collection')).toBe('net.worldmesh.building');
      return reply(gate);
    });
    const saved = (await (await post('/api/account/building/collect', cookie, { connectionId, modelId: gate.uri })).json()) as BuildingList;
    expect(saved.buildings[0]).toMatchObject({ provider: 'atproto', modelId: gate.uri, name: 'Gate', bytes: 2_500_000 });
    // A record elsewhere, or a character record, cannot be saved as a building.
    for (const modelId of [`at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/net.worldmesh.building/3kgate`, `at://${DID}/app.at3d.avatar/3kgate`]) {
      expect((await post('/api/account/building/collect', cookie, { connectionId, modelId })).status).toBe(404);
    }
  });

  it('asks Sketchfab for permission to upload a building, and says so on the way back', async () => {
    const { cookie } = await signedInUser('buildings-sf-upload@example.com');
    await connectSketchfab(cookie);
    const start = await post('/api/account/avatar/connect/sketchfab', cookie, { upload: 'building' });
    expect(start.status).toBe(200);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state');
    route('POST', `${SKETCHFAB}/oauth2/token/`, () => reply({ access_token: 'sf-building-access', refresh_token: 'sf-building-refresh', expires_in: 3600 }));
    route('GET', `${SKETCHFAB_API}/v3/me`, () => reply({ uid: SKETCHFAB_USER, username: 'mesh-maker' }));
    const callback = await call(`/api/account/avatar/callback/sketchfab?code=sf-code-3&state=${state}`, {
      headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${cookieValue(start, FLOW_COOKIE)}` },
    });
    expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=upload&provider=sketchfab&kind=building`);
    const withGrant = `${cookie}; ${UPLOAD_COOKIE}=${cookieValue(callback, UPLOAD_COOKIE)}`;
    const grant = (await (await post('/api/account/avatar/upload/grant', withGrant, {})).json()) as Record<string, unknown>;
    expect(grant).toMatchObject({ provider: 'sketchfab', kind: 'building', accessToken: 'sf-building-access' });
  });

  it('asks AT Protocol for permission to create buildings only, and refuses a grant without it', async () => {
    const { cookie } = await signedInUser('buildings-at-upload@example.com');
    const first = await startAtproto(cookie);
    await finishAtproto(cookie, first.flow, await flowState(first.flow), GOOD_TOKEN);

    route('POST', `${AS}/oauth/par`, async (request) => {
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      expect(form).toMatchObject({ scope: BUILDING_UPLOAD_SCOPE, login_hint: HANDLE });
      return reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-b' }, 201, { 'DPoP-Nonce': 'nonce-2' });
    });
    const flowFor = async () => cookieValue(await post('/api/account/avatar/connect/atproto', cookie, { upload: 'building' }), FLOW_COOKIE);

    // A grant for characters is not one for buildings.
    const wrong = await flowFor();
    const refused = await finishAtproto(cookie, wrong, await flowState(wrong), { ...GOOD_TOKEN, scope: UPLOAD_SCOPE });
    expect(refused.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error`);

    const flow = await flowFor();
    const callback = await finishAtproto(cookie, flow, await flowState(flow), { ...GOOD_TOKEN, scope: BUILDING_UPLOAD_SCOPE });
    expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=upload&provider=atproto&kind=building`);
    const withGrant = `${cookie}; ${UPLOAD_COOKIE}=${cookieValue(callback, UPLOAD_COOKIE)}`;
    const grant = (await (await post('/api/account/avatar/upload/grant', withGrant, {})).json()) as Record<string, unknown>;
    expect(grant).toMatchObject({ provider: 'atproto', kind: 'building', service: PDS, account: DID });
  });

  it('forgets the old account’s buildings when a platform is reconnected as another', async () => {
    const { cookie } = await signedInUser('buildings-reconnect@example.com');
    const connectionId = await connectSketchfab(cookie);
    route('GET', `${SKETCHFAB_API}/v3/models/${BUILDING_MODEL}`, () => reply(sketchfabModel(BUILDING_MODEL, SKETCHFAB_USER, 'Gatehouse')));
    await post('/api/account/building/collect', cookie, { connectionId, modelId: BUILDING_MODEL });
    expect((await buildingList(cookie)).buildings).toHaveLength(1);

    const start = await post('/api/account/avatar/connect/sketchfab', cookie, {});
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state');
    route('POST', `${SKETCHFAB}/oauth2/token/`, () => reply({ access_token: 'sf-other', refresh_token: 'sf-other-r', expires_in: 3600 }));
    route('GET', `${SKETCHFAB_API}/v3/me`, () => reply({ uid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', username: 'someone-else' }));
    await call(`/api/account/avatar/callback/sketchfab?code=sf-code-4&state=${state}`, {
      headers: { Cookie: `${cookie}; ${FLOW_COOKIE}=${cookieValue(start, FLOW_COOKIE)}` },
    });
    expect((await buildingList(cookie)).buildings).toEqual([]);
  });
});

// ── Buildings on worlds ──────────────────────────────────────────────────────

const SHA = 'a'.repeat(64);

/** The world's manifest: `building` names one, null serves one without, undefined serves none. */
function manifest(building: string | null | undefined) {
  route('GET', `${WORLD}/.well-known/worldmesh.json`, () => (building === undefined ? new Response('Not found', { status: 404 }) : reply({ worldmesh: 1, name: 'Forest', ...(building ? { building } : {}) })));
  route('GET', `${WORLD}/worldmesh.json`, () => new Response('Not found', { status: 404 }));
}

/** A signed-in user with a saved Sketchfab building. */
async function ownerWithBuilding(email: string) {
  const owner = await signedInUser(email);
  const connectionId = await connectSketchfab(owner.cookie);
  route('GET', `${SKETCHFAB_API}/v3/models/${BUILDING_MODEL}`, () => reply(sketchfabModel(BUILDING_MODEL, SKETCHFAB_USER, 'Gatehouse')));
  const saved = (await (await post('/api/account/building/collect', owner.cookie, { connectionId, modelId: BUILDING_MODEL })).json()) as BuildingList;
  return { ...owner, connectionId, buildingId: saved.buildings[0].id };
}

function sketchfabDownload(size = 4_000_000) {
  route('GET', `${SKETCHFAB_API}/v3/models/${BUILDING_MODEL}/download`, () => reply({ glb: { url: SKETCHFAB_GLB, size, expires: 300 } }));
}

async function linked(email: string) {
  const owner = await ownerWithBuilding(email);
  manifest(owner.buildingId);
  expect((await post('/api/account/building/link', owner.cookie, { buildingId: owner.buildingId, world: `${WORLD}/` })).status).toBe(200);
  return owner;
}

let reviewerSession: Awaited<ReturnType<typeof signedInUser>> | null = null;
/** An account in ADMIN_EMAILS (matched case-insensitively), verified. */
async function reviewer() {
  reviewerSession ??= await signedInUser('reviewer@example.com');
  return reviewerSession;
}

function decide(cookie: string, body: Record<string, unknown>, origin = ORIGIN) {
  return post('/api/account/building/review', cookie, { world: WORLD, ...body }, origin);
}

async function approvedWorlds() {
  const res = await call('/api/account/building/worlds');
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  return ((await res.json()) as { worlds: { url: string; sha256: string }[] }).worlds;
}

async function resolveWorld(world = WORLD) {
  const res = await call('/api/account/building/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://other-hub.example' },
    body: JSON.stringify({ worlds: [world] }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  return ((await res.json()) as { buildings: Record<string, { modelUrl: string; expiresAt: string | null; sha256: string }> }).buildings;
}

describe('Buildings on worlds', { timeout: 20_000 }, () => {
  afterEach(async () => {
    await env.DB.prepare('delete from building_link').run();
  });

  it('links a building only once the world’s manifest names it, and only for its owner', async () => {
    const owner = await ownerWithBuilding('links-owner@example.com');
    const link = (world: unknown, cookie = owner.cookie, buildingId = owner.buildingId) =>
      post('/api/account/building/link', cookie, { buildingId, world });

    manifest(undefined);
    const none = await link(WORLD);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toContain(`"building": "${owner.buildingId}"`);
    manifest(null);
    expect(((await (await link(WORLD)).json()) as { error: string }).error).toMatch(/does not name this building/);
    manifest('bld_someoneelse000000');
    expect((await link(WORLD)).status).toBe(409);

    expect((await link('http://forest.worlds.example.org')).status).toBe(400);
    expect((await link('not a url')).status).toBe(400);
    expect((await link('https://10.0.0.1/world')).status).toBe(400);

    manifest(owner.buildingId);
    const other = await signedInUser('links-other@example.com');
    expect((await link(WORLD, other.cookie)).status).toBe(404);
    expect((await post('/api/account/building/link', owner.cookie, { buildingId: owner.buildingId, world: WORLD }, 'https://evil.example')).status).toBe(403);

    // The address is kept as the hub compares them: lower-case host, no trailing slash or hash.
    const ok = (await (await link('https://Forest.Worlds.Example.org/#spawn')).json()) as BuildingList;
    expect(ok.buildings[0].worlds).toEqual([{ url: WORLD, status: 'pending', reason: null }]);
    // Waiting for review: not in the city yet.
    expect(await approvedWorlds()).toEqual([]);

    // Someone else can't take it off; its owner can.
    await post('/api/account/building/unlink', other.cookie, { buildingId: owner.buildingId, world: WORLD });
    expect((await buildingList(owner.cookie)).buildings[0].worlds).toHaveLength(1);
    const off = (await (await post('/api/account/building/unlink', owner.cookie, { buildingId: owner.buildingId, world: WORLD })).json()) as BuildingList;
    expect(off.buildings[0].worlds).toEqual([]);
  });

  it('lets reviewers only see the queue, check the file and decide', async () => {
    const owner = await linked('review-owner@example.com');
    const reviewerUser = await reviewer();

    expect((await call('/api/account/building/review/queue', { headers: { Cookie: owner.cookie } })).status).toBe(403);
    // An unverified email on the list is not a reviewer.
    const unverified = await signedInUser('someone@example.com', false);
    expect((await call('/api/account/building/review/queue', { headers: { Cookie: unverified.cookie } })).status).toBe(403);

    const queue = (await (await call('/api/account/building/review/queue', { headers: { Cookie: reviewerUser.cookie } })).json()) as {
      links: { world: string; status: string; buildingId: string; buildingName: string }[];
    };
    expect(queue.links).toEqual([expect.objectContaining({ world: WORLD, status: 'pending', buildingId: owner.buildingId, buildingName: 'Gatehouse' })]);

    sketchfabDownload();
    const details = (await (await call(`/api/account/building/review?world=${encodeURIComponent(WORLD)}`, { headers: { Cookie: reviewerUser.cookie } })).json()) as {
      link: { status: string };
      building: { id: string; name: string; providerLabel: string };
      owner: { email: string };
      file: { modelUrl: string; version: string; expiresAt: string };
    };
    expect(details.link.status).toBe('pending');
    expect(details.building).toMatchObject({ id: owner.buildingId, name: 'Gatehouse', providerLabel: 'Sketchfab' });
    expect(details.owner.email).toBe('review-owner@example.com');
    expect(details.file).toMatchObject({ modelUrl: SKETCHFAB_GLB, version: 'size:4000000' });

    // Approving pins the hash the reviewer's browser computed.
    expect((await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve' })).status).toBe(400);
    expect((await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA }, 'https://evil.example')).status).toBe(403);
    expect((await decide(owner.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA })).status).toBe(403);
    expect((await decide(reviewerUser.cookie, { buildingId: 'bld_notthisone00000', action: 'approve', sha256: SHA })).status).toBe(409);
    const approve = await decide(reviewerUser.cookie, {
      buildingId: owner.buildingId,
      action: 'approve',
      sha256: SHA,
      version: details.file.version,
      portal: { width: 4, height: 5 },
    });
    expect(await approve.json()).toEqual({ ok: true, status: 'approved' });
    expect((await buildingList(owner.cookie)).buildings[0].worlds).toEqual([{ url: WORLD, status: 'approved', reason: null }]);

    // Rejecting needs a reason, which the owner sees.
    expect((await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'reject' })).status).toBe(400);
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'reject', reason: 'The door is  behind a wall.' });
    expect((await buildingList(owner.cookie)).buildings[0].worlds).toEqual([{ url: WORLD, status: 'rejected', reason: 'The door is behind a wall.' }]);
    // Linking it again sends it back for review.
    manifest(owner.buildingId);
    await post('/api/account/building/link', owner.cookie, { buildingId: owner.buildingId, world: WORLD });
    expect((await buildingList(owner.cookie)).buildings[0].worlds[0]).toMatchObject({ status: 'pending', reason: null });

    // Hidden stays hidden: linking again is refused.
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'hide', reason: 'Reported.' });
    const again = await post('/api/account/building/link', owner.cookie, { buildingId: owner.buildingId, world: WORLD });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/taken down from that world: Reported\./);
  });

  it('tells the city which worlds have a building, where to download it, and takes back a replaced file', async () => {
    const owner = await linked('city-owner@example.com');
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA, version: 'size:4000000' });

    expect(await approvedWorlds()).toEqual([{ url: WORLD, sha256: SHA }]);
    const preflight = await call('/api/account/building/resolve', { method: 'OPTIONS', headers: { Origin: 'https://other-hub.example' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

    sketchfabDownload();
    const resolved = await resolveWorld(`${WORLD}/`);
    expect(resolved[WORLD]).toMatchObject({ modelUrl: SKETCHFAB_GLB, sha256: SHA });
    expect(Date.parse(resolved[WORLD].expiresAt!)).toBeGreaterThan(Date.now());
    // Worlds without an approved building are simply missing from the answer.
    expect(await resolveWorld('https://nowhere.example.org')).toEqual({});
    const tooMany = await call('/api/account/building/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worlds: Array.from({ length: 17 }, (_, i) => `https://w${i}.example.org`) }),
    });
    expect(tooMany.status).toBe(400);

    // The owner replaced the file on Sketchfab: not shown, and back in review.
    sketchfabDownload(4_100_000);
    expect(await resolveWorld()).toEqual({});
    expect(await approvedWorlds()).toEqual([]);
    expect((await buildingList(owner.cookie)).buildings[0].worlds[0]).toMatchObject({ status: 'pending', reason: expect.stringMatching(/file changed/) });
  });

  it('resolves AT Protocol buildings to their blob, and notices a replaced one by its CID', async () => {
    const { cookie } = await signedInUser('city-atproto@example.com');
    const { flow } = await startAtproto(cookie);
    await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    const connectionId = (await buildingList(cookie)).connections[0].id;
    let record = buildingRecord('3kcity', 'City Gate');
    route('GET', `${PDS}/xrpc/com.atproto.repo.getRecord`, () => reply(record));
    const buildingId = ((await (await post('/api/account/building/collect', cookie, { connectionId, modelId: record.uri })).json()) as BuildingList).buildings[0].id;
    manifest(buildingId);
    await post('/api/account/building/link', cookie, { buildingId, world: WORLD });
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId, action: 'approve', sha256: SHA, version: 'bafkreibuildingmodel' });

    const resolved = await resolveWorld();
    expect(resolved[WORLD]).toEqual({
      modelUrl: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafkreibuildingmodel`,
      expiresAt: null,
      sha256: SHA,
    });

    record = { ...record, value: { ...record.value, model: { ...record.value.model, ref: { $link: 'bafkreianothermodel' } } } };
    expect(await resolveWorld()).toEqual({});
    expect((await buildingList(cookie)).buildings[0].worlds[0].status).toBe('pending');
  });

  it('takes a building down once its world’s manifest stops naming it, but not while the site is down', async () => {
    const owner = await linked('recheck-owner@example.com');
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA });
    const age = () => env.DB.prepare('update building_link set checked_at = ?1').bind(Date.now() - 2 * 24 * 60 * 60_000).run();

    await age();
    route('GET', `${WORLD}/.well-known/worldmesh.json`, () => new Response('down', { status: 503 }));
    route('GET', `${WORLD}/worldmesh.json`, () => new Response('down', { status: 503 }));
    await recheckStale(env, ORIGIN);
    expect(await approvedWorlds()).toHaveLength(1);

    await age();
    manifest(null);
    await recheckStale(env, ORIGIN);
    expect(await approvedWorlds()).toEqual([]);
    expect((await buildingList(owner.cookie)).buildings[0].worlds).toEqual([]);
  });

  it('lets signed-in visitors report a standing building once, and reviewers dismiss reports or act on them', async () => {
    const owner = await linked('reported-owner@example.com');
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA });
    const report = (cookie: string | null, body: Record<string, unknown>) => post('/api/account/building/report', cookie, { world: WORLD, ...body });

    const first = await signedInUser('reporter-one@example.com');
    const second = await signedInUser('reporter-two@example.com');
    expect((await report(null, { reason: 'offensive' })).status).toBe(401);
    expect((await report(first.cookie, { reason: 'boring' })).status).toBe(400);
    expect((await report(first.cookie, { reason: 'offensive' })).status).toBe(200);
    expect((await post('/api/account/building/report', first.cookie, { world: 'https://nowhere.example.org', reason: 'other' })).status).toBe(404);
    expect((await post('/api/account/building/report', first.cookie, { world: WORLD, reason: 'other' }, 'https://evil.example')).status).toBe(403);
    // Reporting again changes nothing.
    expect(await (await report(first.cookie, { reason: 'violent' })).json()).toEqual({ ok: true, alreadyReported: true });
    expect(await (await report(second.cookie, { reason: 'copyright', note: '  my   castle,  copied ' })).json()).toEqual({ ok: true, alreadyReported: false });

    const queue = (await (await call('/api/account/building/review/queue', { headers: { Cookie: reviewerUser.cookie } })).json()) as {
      links: { world: string; reports: number }[];
    };
    expect(queue.links.find((link) => link.world === WORLD)?.reports).toBe(2);
    sketchfabDownload();
    const details = (await (await call(`/api/account/building/review?world=${encodeURIComponent(WORLD)}`, { headers: { Cookie: reviewerUser.cookie } })).json()) as {
      reports: { reason: string; note: string | null; sameFile: boolean; reporter: string }[];
    };
    expect(details.reports).toEqual([
      expect.objectContaining({ reason: 'offensive', note: null, sameFile: true, reporter: 'reporter-one@example.com' }),
      expect.objectContaining({ reason: 'copyright', note: 'my castle, copied', sameFile: true }),
    ]);

    // Dismissed: the building stays, the reports are closed, and a new one can be made.
    expect((await decide(owner.cookie, { buildingId: owner.buildingId, action: 'dismiss' })).status).toBe(403);
    expect(await (await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'dismiss' })).json()).toEqual({ ok: true, dismissed: 2 });
    expect(await approvedWorlds()).toHaveLength(1);
    expect(await (await report(first.cookie, { reason: 'broken' })).json()).toEqual({ ok: true, alreadyReported: false });

    // Hidden: down at once, and its reports acted on.
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'hide', reason: 'Copied from someone else.' });
    expect(await approvedWorlds()).toEqual([]);
    expect((await report(second.cookie, { reason: 'other' })).status).toBe(404);
    const statuses = await env.DB.prepare('select status, count(*) as n from building_report group by status order by status').all<{ status: string; n: number }>();
    expect(statuses.results).toEqual([
      { status: 'actioned', n: 1 },
      { status: 'dismissed', n: 2 },
    ]);
    expect((await buildingList(owner.cookie)).buildings[0].worlds).toEqual([{ url: WORLD, status: 'hidden', reason: 'Copied from someone else.' }]);
    await env.DB.prepare('delete from building_report').run();
  });

  it('emails reviewers about a first report, and owners about a decision, where email is set up', async () => {
    const mailEnv = { ...env, RESEND_API_KEY: 're_test', AUTH_FROM_EMAIL: 'WorldMesh <accounts@worldmesh.net>' } as Env;
    const sent: { to: string; subject: string; text: string }[] = [];
    route('POST', 'https://api.resend.com/emails', async (request) => {
      sent.push((await request.json()) as { to: string; subject: string; text: string });
      return reply({ id: 'email-1' });
    });
    const withMail = async (path: string, cookie: string, body: unknown) => {
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext;
      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(body) }),
        mailEnv,
        ctx,
      );
      await Promise.all(pending);
      return response;
    };

    const owner = await linked('mailed-owner@example.com');
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId: owner.buildingId, action: 'approve', sha256: SHA });
    const first = await signedInUser('mail-reporter-one@example.com');
    const second = await signedInUser('mail-reporter-two@example.com');
    expect((await withMail('/api/account/building/report', first.cookie, { world: WORLD, reason: 'sexual' })).status).toBe(200);
    expect(sent.map((mail) => mail.to)).toEqual(['reviewer@example.com', 'someone@example.com']);
    expect(sent[0].subject).toBe('A building in the city was reported');
    expect(sent[0].text).toContain('Gatehouse, standing on https://forest.worlds.example.org in the hub city, was reported as sexual content.');
    expect(sent[0].text).toContain(`${ORIGIN}/review-building?world=${encodeURIComponent(WORLD)}`);
    expect(sent[0].text).not.toMatch(/If this wasn't you/);
    // More reports pile up on the dashboard without more email.
    await withMail('/api/account/building/report', second.cookie, { world: WORLD, reason: 'other' });
    expect(sent).toHaveLength(2);

    await withMail('/api/account/building/review', reviewerUser.cookie, { world: WORLD, buildingId: owner.buildingId, action: 'hide', reason: 'Not for everyone.' });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ to: 'mailed-owner@example.com', subject: 'Your building was taken down' });
    expect(sent[2].text).toContain('Gatehouse was taken down from https://forest.worlds.example.org in the hub city: Not for everyone.');
    await env.DB.prepare('delete from building_report').run();
  });

  it('gives a world to the building its manifest names now, and lets links go with their building', async () => {
    const first = await linked('first-owner@example.com');
    const reviewerUser = await reviewer();
    await decide(reviewerUser.cookie, { buildingId: first.buildingId, action: 'approve', sha256: SHA });

    // The world's manifest now names someone else's building: the world changes hands, back to review.
    const second = await ownerWithBuilding('second-owner@example.com');
    manifest(second.buildingId);
    await post('/api/account/building/link', second.cookie, { buildingId: second.buildingId, world: WORLD });
    expect((await buildingList(first.cookie)).buildings[0].worlds).toEqual([]);
    expect((await buildingList(second.cookie)).buildings[0].worlds).toEqual([{ url: WORLD, status: 'pending', reason: null }]);
    expect(await approvedWorlds()).toEqual([]);

    await post('/api/account/building/remove', second.cookie, { buildingId: second.buildingId });
    expect((await env.DB.prepare('select count(*) as n from building_link').first<{ n: number }>())?.n).toBe(0);
  });
});

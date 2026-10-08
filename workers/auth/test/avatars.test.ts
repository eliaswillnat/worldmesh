import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { createAuth } from '../src/auth';
import { atprotoClientId, CLIENT_SCOPE } from '../src/avatars/atproto';
import { fromBase64url, pkceChallenge, seal } from '../src/avatars/crypto';

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
const STUBBED = new Set(['hub.vroid.com', 'sketchfab.com', 'api.sketchfab.com', 'plc.directory', 'cloudflare-dns.com', 'pds.pds-fixture.net', 'auth.pds-fixture.net', 'alice.pds-fixture.net', '10.0.0.1']);
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

async function signedInUser(email: string) {
  const ctx = await createAuth(env).$context;
  const user = await ctx.internalAdapter.createUser({ name: 'Test User', email, emailVerified: true });
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
  expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected#list`);
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
        { id: 'sketchfab', label: 'Sketchfab', uploads: false },
        { id: 'vroid', label: 'VRoid Hub', uploads: false },
        { id: 'atproto', label: 'at3d', uploads: true },
      ],
      connections: [],
      selected: null,
    });
  });

  it('refuses cross-site state changes', async () => {
    const { cookie } = await signedInUser('csrf-avatar@example.com');
    for (const path of ['connect/vroid', 'select', 'disconnect', 'handoff', 'upload/session', 'upload/finish']) {
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
    expect(forged.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error#list`);
    const hijack = await call(`/api/account/avatar/callback/vroid?code=x&state=${state}`, {
      headers: { Cookie: `${other.cookie}; ${FLOW_COOKIE}=${flow}` },
    });
    expect(hijack.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error#list`);
    const noCookie = await call(`/api/account/avatar/callback/vroid?code=x&state=${state}`, { headers: { Cookie: cookie } });
    expect(noCookie.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error#list`);
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
    expect(((await cleared.json()) as { selected: unknown }).selected).toBeNull();
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

const UPLOAD_SCOPE = 'atproto repo:app.at3d.avatar?action=create blob?accept=model/gltf-binary&accept=application/octet-stream';

async function startAtproto(cookie: string, body: Record<string, unknown> = { handle: `@${HANDLE}` }, scope = 'atproto') {
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
      scope,
      login_hint: HANDLE,
    });
    return reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 300 }, 201, { 'DPoP-Nonce': 'nonce-2' });
  });
  const start = await post('/api/account/avatar/connect/atproto', cookie, body);
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
      redirect_uris: [`${ORIGIN}/api/account/avatar/callback/atproto`],
      scope: UPLOAD_SCOPE,
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
    });
    expect(atprotoClientId('http://127.0.0.1:5170', 'http://127.0.0.1:5170/api/account/avatar/callback/atproto')).toBe(
      `http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A5170%2Fapi%2Faccount%2Favatar%2Fcallback%2Fatproto&scope=${encodeURIComponent(UPLOAD_SCOPE).replace(/%20/g, '+')}`,
    );
    expect(CLIENT_SCOPE).toBe(UPLOAD_SCOPE);
    expect(() => atprotoClientId('http://localhost:5170', 'x')).toThrow(/127\.0\.0\.1/);
  });

  it('proves the DID with PAR + DPoP, then keeps no tokens', async () => {
    const { user, cookie } = await signedInUser('at-connect@example.com');
    const { flow } = await startAtproto(cookie);
    const res = await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected#list`);
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
    expect(wrongIss.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error#list`);

    const second = await startAtproto(cookie);
    const otherAccount = await finishAtproto(cookie, second.flow, await flowState(second.flow), {
      ...GOOD_TOKEN,
      sub: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect(otherAccount.headers.get('Location')).toBe(`${ORIGIN}/?avatar=error#list`);
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
      },
    });
  });
});

// ── at3d: upload from device ─────────────────────────────────────────────────

const UPLOAD_TOKEN = { ...GOOD_TOKEN, access_token: 'at-upload-access', refresh_token: 'at-upload-refresh', scope: UPLOAD_SCOPE, expires_in: 900 };
const MODEL_BLOB = { $type: 'blob', ref: { $link: 'bafkreiuploadedmodel' }, mimeType: 'model/gltf-binary', size: 2_000_000 };

async function authorizeUpload(cookie: string, body: Record<string, unknown>) {
  const { flow } = await startAtproto(cookie, body, UPLOAD_SCOPE);
  const res = await finishAtproto(cookie, flow, await flowState(flow), UPLOAD_TOKEN);
  expect(res.headers.get('Location')).toBe(`${ORIGIN}/?avatar=upload#list`);
  return cookieValue(res, UPLOAD_COOKIE);
}

function stubCreateRecord(check: (body: Record<string, unknown>) => void = () => {}) {
  let attempts = 0;
  route('POST', `${PDS}/xrpc/com.atproto.repo.createRecord`, async (request) => {
    attempts++;
    const proof = await verifyDpop(request);
    expect(request.headers.get('Authorization')).toBe('DPoP at-upload-access');
    const ath = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('at-upload-access')));
    expect(proof).toMatchObject({ htm: 'POST', htu: `${PDS}/xrpc/com.atproto.repo.createRecord`, ath: btoa(String.fromCharCode(...ath)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') });
    // The PDS keeps its own nonce.
    if (!proof.nonce) return reply({ error: 'use_dpop_nonce' }, 401, { 'DPoP-Nonce': 'pds-nonce-1', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' });
    expect(proof.nonce).toBe('pds-nonce-1');
    const body = (await request.json()) as Record<string, unknown>;
    check(body);
    return reply({ uri: `at://${DID}/app.at3d.avatar/3lupload`, cid: 'bafyreinewrecord' });
  });
  return () => attempts;
}

/** An upload call with its grant cookie; waits for background work (revocation) to finish. */
async function uploadCall(path: string, cookie: string, grant: string, body: unknown) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/account/avatar/upload/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `${cookie}; ${UPLOAD_COOKIE}=${grant}` },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await Promise.all(pending);
  return res;
}

describe('at3d / upload from device', () => {
  it('asks for create-avatar and model-upload permission only, and keeps the grant out of D1', async () => {
    const { user, cookie } = await signedInUser('at-upload@example.com');
    const grant = await authorizeUpload(cookie, { handle: HANDLE, upload: true });
    // Not revoked yet, and nothing stored but the connection.
    expect(calls.some((c) => c.url === `${AS}/oauth/revoke`)).toBe(false);
    const row = await env.DB.prepare('select * from avatar_connection where user_id = ?').bind(user.id).first();
    expect(row).toMatchObject({ provider_account_id: DID, token_enc: null });
    expect(decodeURIComponent(grant)).not.toMatch(/at-upload/);

    const session = await uploadCall('session', cookie, grant, {});
    expect(session.status).toBe(200);
    const target = (await session.json()) as { url: string; accessToken: string; dpopKey: JsonWebKey };
    expect(target.url).toBe(`${PDS}/xrpc/com.atproto.repo.uploadBlob`);
    expect(target.accessToken).toBe('at-upload-access');
    expect(target.dpopKey).toMatchObject({ kty: 'EC', crv: 'P-256' });

    // Someone else's session cannot use the grant.
    const other = await signedInUser('at-upload-other@example.com');
    const stolen = await uploadCall('session', other.cookie, grant, {});
    expect(stolen.status).toBe(409);
  });

  it('creates an app.at3d.avatar record for the uploaded blob, then revokes the grant', async () => {
    const { cookie } = await signedInUser('at-upload-create@example.com');
    const grant = await authorizeUpload(cookie, { handle: HANDLE, upload: true });
    let record: Record<string, unknown> = {};
    const attempts = stubCreateRecord((body) => {
      expect(body).toMatchObject({ repo: DID, collection: 'app.at3d.avatar' });
      record = body.record as Record<string, unknown>;
    });
    route('POST', `${AS}/oauth/revoke`, () => new Response(null, { status: 200 }));
    const res = await uploadCall('finish', cookie, grant, {
      name: 'Robo Knight',
      format: 'vrm',
      vrmVersion: '1.0',
      file: { ...MODEL_BLOB, extra: 'dropped' },
    });
    expect(res.status).toBe(200);
    expect(attempts()).toBe(2);
    expect(record).toEqual({
      $type: 'app.at3d.avatar',
      name: 'Robo Knight',
      format: 'vrm',
      appearance: {
        $type: 'app.at3d.avatar#vrmAppearance',
        model: { $type: 'blob', ref: { $link: 'bafkreiuploadedmodel' }, mimeType: 'model/gltf-binary', size: 2_000_000 },
        vrmVersion: '1.0',
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const { connectionId, avatar } = (await res.json()) as { connectionId: string; avatar: Record<string, unknown> };
    expect(avatar).toEqual({
      id: `at://${DID}/app.at3d.avatar/3lupload`,
      name: 'Robo Knight',
      thumbnail: null,
      format: 'vrm',
      metadata: { modelCid: 'bafkreiuploadedmodel', vrmVersion: '1.0' },
    });
    expect(typeof connectionId).toBe('string');
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${UPLOAD_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(true);
    const revoke = calls.find((c) => c.url === `${AS}/oauth/revoke`);
    expect(new URLSearchParams(await revoke!.text()).get('token')).toBe('at-upload-refresh');
    // Revoked only once the record exists.
    expect(calls.findIndex((c) => c.url === `${AS}/oauth/revoke`)).toBeGreaterThan(
      calls.findLastIndex((c) => c.url.endsWith('createRecord')),
    );
  });

  it('re-authorizes an already connected account without asking for the handle', async () => {
    const { cookie } = await signedInUser('at-upload-again@example.com');
    const { flow } = await startAtproto(cookie);
    await finishAtproto(cookie, flow, await flowState(flow), GOOD_TOKEN);
    await authorizeUpload(cookie, { upload: true });

    const { cookie: fresh } = await signedInUser('at-upload-nohandle@example.com');
    expect((await post('/api/account/avatar/connect/atproto', fresh, { upload: true })).status).toBe(400);
  });

  it('refuses a malformed blob or an unknown format, and still revokes', async () => {
    const { cookie } = await signedInUser('at-upload-bad@example.com');
    for (const body of [
      { format: 'glb', file: { ...MODEL_BLOB, mimeType: 'text/html' } },
      { format: 'glb', file: { ...MODEL_BLOB, size: 11 * 1024 * 1024 } },
      { format: 'fbx', file: MODEL_BLOB },
    ]) {
      const grant = await authorizeUpload(cookie, { handle: HANDLE, upload: true });
      calls.length = 0;
      route('POST', `${AS}/oauth/revoke`, () => new Response(null, { status: 200 }));
      const res = await uploadCall('finish', cookie, grant, body);
      expect(res.status).toBe(400);
      expect(calls.some((c) => c.url.includes('createRecord'))).toBe(false);
      expect(calls.some((c) => c.url === `${AS}/oauth/revoke`)).toBe(true);
    }
  });

  it('cancels by revoking the grant', async () => {
    const { cookie } = await signedInUser('at-upload-cancel@example.com');
    const grant = await authorizeUpload(cookie, { handle: HANDLE, upload: true });
    route('POST', `${AS}/oauth/revoke`, () => new Response(null, { status: 200 }));
    const res = await uploadCall('finish', cookie, grant, { cancel: true });
    expect(await res.json()).toEqual({ cancelled: true });
    expect(calls.some((c) => c.url === `${AS}/oauth/revoke`)).toBe(true);
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
  expect(callback.headers.get('Location')).toBe(`${ORIGIN}/?avatar=connected#list`);
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

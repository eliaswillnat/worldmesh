import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { createAuth } from '../src/auth';

const ORIGIN = 'https://worldmesh.net';
const SECRET = 'test-secret-test-secret-test-secret-123';
const SESSION_COOKIE = '__Secure-worldmesh.session_token';
const FLOW_COOKIE = '__Secure-worldmesh.atproto_flow';
const CALLBACK = `${ORIGIN}/api/auth/atproto/callback`;

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const HANDLE = 'alice.pds-fixture.net';
const PDS = 'https://pds.pds-fixture.net';
const AS = 'https://auth.pds-fixture.net';

let database: TestDatabase;
let env: Env;

// Only AT Protocol hosts are stubbed; anything else (the local D1 proxy) passes through.
type Handler = (request: Request) => Response | Promise<Response>;
const routes = new Map<string, Handler>();
const calls: Request[] = [];
const STUBBED = new Set(['plc.directory', 'cloudflare-dns.com', 'pds.pds-fixture.net', 'auth.pds-fixture.net']);
const realFetch = globalThis.fetch;

function route(method: string, url: string, handler: Handler) {
  routes.set(`${method} ${url}`, handler);
}
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never);
  env = { DB: database.db, BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: SECRET };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!STUBBED.has(url.hostname)) return realFetch(input, init);
    calls.push(request.clone());
    const handler = routes.get(`${request.method} ${url.origin}${url.pathname}`);
    if (!handler) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
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

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

function cookieValue(response: Response, name: string): string | null {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0].slice(name.length + 1) : null;
}

function stubServer(sub = DID, profile: Record<string, unknown> | null = { displayName: 'Alice' }) {
  route('GET', 'https://cloudflare-dns.com/dns-query', () =>
    reply({ Status: 0, Answer: [{ name: `_atproto.${HANDLE}`, type: 16, data: `"did=${DID}"` }] }),
  );
  route('GET', `https://plc.directory/${DID}`, () =>
    reply({
      id: DID,
      alsoKnownAs: [`at://${HANDLE}`],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
    }),
  );
  route('GET', `${PDS}/.well-known/oauth-protected-resource`, () => reply({ resource: PDS, authorization_servers: [AS] }));
  route('GET', `${AS}/.well-known/oauth-authorization-server`, () =>
    reply({
      issuer: AS,
      authorization_endpoint: `${AS}/oauth/authorize`,
      token_endpoint: `${AS}/oauth/token`,
      pushed_authorization_request_endpoint: `${AS}/oauth/par`,
      revocation_endpoint: `${AS}/oauth/revoke`,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['atproto'],
      dpop_signing_alg_values_supported: ['ES256'],
    }),
  );
  route('POST', `${AS}/oauth/par`, async (request) => {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    expect(form).toMatchObject({
      client_id: `${ORIGIN}/api/account/avatar/atproto/client-metadata.json`,
      redirect_uri: CALLBACK,
      scope: 'atproto',
      login_hint: HANDLE,
      code_challenge_method: 'S256',
    });
    return reply({ request_uri: 'urn:ietf:params:oauth:request_uri:req-1' }, 201, { 'DPoP-Nonce': 'nonce-1' });
  });
  route('POST', `${AS}/oauth/token`, async (request) => {
    const form = new URLSearchParams(await request.text());
    expect(form.get('redirect_uri')).toBe(CALLBACK);
    return reply({ access_token: 'at-access', refresh_token: 'at-refresh', token_type: 'DPoP', sub, scope: 'atproto' });
  });
  route('POST', `${AS}/oauth/revoke`, () => new Response(null, { status: 200 }));
  route('GET', `${PDS}/xrpc/com.atproto.repo.getRecord`, () =>
    profile ? reply({ value: { ...profile, avatar: { ref: { $link: 'bafkreiavatarcid' }, mimeType: 'image/jpeg' } } }) : reply({}, 404),
  );
}

let clients = 0;

async function start(body: Record<string, unknown> = { handle: `@${HANDLE}` }) {
  const res = await call('/api/auth/sign-in/atproto', {
    method: 'POST',
    // A fresh client IP each time: the suite would otherwise trip the sign-in rate limit.
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': `203.0.113.${++clients % 250}` },
    body: JSON.stringify(body),
  });
  return { res, flow: cookieValue(res, FLOW_COOKIE) };
}

async function stateOf(flow: string): Promise<string> {
  return JSON.parse(await symmetricDecrypt({ key: SECRET, data: decodeURIComponent(flow) })).state;
}

async function finish(flow: string | null, query: Record<string, string>) {
  return call(`/api/auth/atproto/callback?${new URLSearchParams(query)}`, {
    headers: flow ? { Cookie: `${FLOW_COOKIE}=${flow}` } : {},
  });
}

async function signIn(callbackURL?: string) {
  const { res, flow } = await start({ handle: HANDLE, ...(callbackURL && { callbackURL }) });
  expect(res.status).toBe(200);
  return finish(flow, { code: 'code-1', state: await stateOf(flow!), iss: AS });
}

describe('Sign in with ATProto', () => {
  it('sends the visitor to their own server with PAR + PKCE + DPoP, keeping the flow sealed in a cookie', async () => {
    stubServer();
    const { res, flow } = await start();
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${AS}/oauth/authorize`);
    expect(url.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:req-1');
    expect(flow).toBeTruthy();
    // The DPoP private key travels in it, so it must not be readable.
    expect(decodeURIComponent(flow!)).not.toMatch(/"d"|did:plc/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${FLOW_COOKIE}=`))!;
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
  });

  it('creates an account for a new DID, signs it in, and hands the tokens back', async () => {
    stubServer();
    const res = await signIn();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/?auth=new`);
    const session = cookieValue(res, SESSION_COOKIE);
    expect(session).toBeTruthy();

    const me = (await (await call('/api/account/me', { headers: { Cookie: `${SESSION_COOKIE}=${session}` } })).json()) as {
      user: { name: string; image: string } | null;
    };
    expect(me.user).toMatchObject({
      name: 'Alice',
      image: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafkreiavatarcid`,
    });
    const account = await env.DB.prepare('select "userId", "accessToken" from account where "providerId" = ? and "accountId" = ?')
      .bind('atproto', DID)
      .first<{ userId: string; accessToken: string | null }>();
    expect(account?.accessToken).toBeNull();
    const user = await env.DB.prepare('select email, "emailVerified" from "user" where id = ?').bind(account!.userId).first();
    expect(user).toMatchObject({ email: 'did-plc-abcdefghijklmnopqrstuvwx@atproto.invalid', emailVerified: 0 });
    const revoke = calls.find((c) => c.url === `${AS}/oauth/revoke`);
    expect(new URLSearchParams(await revoke!.text()).get('token')).toBe('at-refresh');
  });

  it('signs the same DID into the same account next time, back to where they were', async () => {
    stubServer();
    const res = await signIn('/#walk');
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/#walk`);
    const { n } = (await env.DB.prepare('select count(*) as n from account where "providerId" = ?').bind('atproto').first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it('signs in the Avatar Wallet user who already proved this DID, instead of making a second account', async () => {
    await env.DB.prepare('delete from account where "providerId" = ?').bind('atproto').run();
    const ctx = await createAuth(env).$context;
    const owner = await ctx.internalAdapter.createUser({ name: 'Wallet Owner', email: 'owner@example.com', emailVerified: true });
    await env.DB.prepare(
      `insert into avatar_connection (id, user_id, provider, provider_account_id, display_name, service_endpoint, created_at, updated_at)
       values ('conn-1', ?1, 'atproto', ?2, ?3, ?4, 0, 0)`,
    )
      .bind(owner.id, DID, HANDLE, PDS)
      .run();
    stubServer();
    const res = await signIn('/');
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/`);
    const account = await env.DB.prepare('select "userId" from account where "providerId" = ? and "accountId" = ?').bind('atproto', DID).first<{ userId: string }>();
    expect(account?.userId).toBe(owner.id);
  });

  it('never redirects off the hub after signing in', async () => {
    stubServer();
    for (const target of ['https://evil.example.com/', '//evil.example.com/', '/\\evil.example.com']) {
      // Better Auth's origin check may refuse it up front; otherwise it is dropped for the hub's root.
      const { res, flow } = await start({ handle: HANDLE, callbackURL: target });
      if (res.status === 403) continue;
      expect(res.status).toBe(200);
      const done = await finish(flow, { code: 'code-1', state: await stateOf(flow!), iss: AS });
      expect(done.headers.get('Location')).toBe(`${ORIGIN}/`);
    }
  });

  it('refuses a callback without this browser’s flow, with the wrong state or issuer, or for another account', async () => {
    stubServer();
    const { flow } = await start();
    const state = await stateOf(flow!);
    const failures = [
      await finish(null, { code: 'code-1', state, iss: AS }),
      await finish(flow, { code: 'code-1', state: 'forged', iss: AS }),
      await finish(flow, { code: 'code-1', state, iss: 'https://evil-as.pds-fixture.net' }),
      await finish(flow, { error: 'access_denied', state, iss: AS }),
    ];
    stubServer('did:plc:zzzzzzzzzzzzzzzzzzzzzzzz');
    const other = await start();
    failures.push(await finish(other.flow, { code: 'code-1', state: await stateOf(other.flow!), iss: AS }));
    for (const res of failures) {
      expect(res.headers.get('Location')).toBe(`${ORIGIN}/?auth=error`);
      expect(cookieValue(res, SESSION_COOKIE)).toBeFalsy();
    }
  });

  it('refuses handles that are malformed or point at private hosts', async () => {
    expect((await start({ handle: 'not a handle' })).res.status).toBe(400);
    expect((await start({})).res.status).toBe(400);
    route('GET', 'https://cloudflare-dns.com/dns-query', () => reply({ Status: 0, Answer: [{ data: `"did=${DID}"` }] }));
    route('GET', `https://plc.directory/${DID}`, () =>
      reply({ id: DID, alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://10.0.0.1' }] }),
    );
    expect((await start()).res.status).toBe(400);
    expect(calls.some((c) => new URL(c.url).hostname === '10.0.0.1')).toBe(false);
  });

  it('keeps the placeholder email domain out of password sign-ups', async () => {
    const res = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ name: 'Mallory', email: 'did-plc-zzzzzzzzzzzzzzzzzzzzzzzz@ATPROTO.invalid', password: 'long-enough-password' }),
    });
    expect(res.status).toBe(400);
  });
});

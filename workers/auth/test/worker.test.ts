import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { getMigrations } from 'better-auth/db/migration';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { createAuth } from '../src/auth';

const ORIGIN = 'https://worldmesh.net';
const SECRET = 'test-secret-test-secret-test-secret-123';
const SESSION_COOKIE = '__Secure-worldmesh.session_token';

let database: TestDatabase;
let env: Env;
let applePublicKey: CryptoKey;

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never);
  const appleKey = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  applePublicKey = appleKey.publicKey;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', appleKey.privateKey)) as ArrayBuffer);
  const p8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
  env = {
    DB: database.db,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    FEDERATION_DOMAIN: 'worldmesh.net',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    APPLE_CLIENT_ID: 'net.worldmesh.signin',
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY: p8,
    DISCORD_CLIENT_ID: 'discord-id',
    DISCORD_CLIENT_SECRET: 'discord-secret',
  };
}, 30_000);

afterAll(async () => {
  await database?.dispose();
});

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

/** Creates a user with a live session, the way an OAuth callback would, and returns its cookie. */
async function signedInUser(email: string) {
  const ctx = await createAuth(env).$context;
  const user = await ctx.internalAdapter.createUser({ name: 'Test User', email, emailVerified: true });
  const session = await ctx.internalAdapter.createSession(user.id);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return { user, cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${session.token}.${signature}`)}` };
}

describe('schema', () => {
  it('matches what Better Auth expects, so it never needs to migrate on its own', async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(createAuth(env).options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});

describe('email and password', () => {
  const post = (path: string, body: unknown, cookie?: string) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(cookie && { Cookie: cookie }) },
      body: JSON.stringify(body),
    });
  const sessionCookie = (res: Response) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];

  it('signs up, stores a PBKDF2 hash and signs in', async () => {
    const signUp = await post('/api/auth/sign-up/email', { name: 'Pat', email: 'pat@example.com', password: 'correct horse battery' });
    expect(signUp.status).toBe(200);
    const cookie = sessionCookie(signUp);
    expect(cookie).toBeTruthy();
    const me = (await (await call('/api/account/me', { headers: { Cookie: cookie! } })).json()) as { user: { name: string } };
    expect(me.user.name).toBe('Pat');

    const row = await env.DB.prepare(
      `select a.password from account a join "user" u on u.id = a.userId where u.email = 'pat@example.com' and a.providerId = 'credential'`,
    ).first<{ password: string }>();
    expect(row?.password).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row?.password).not.toContain('correct horse');

    const signIn = await post('/api/auth/sign-in/email', { email: 'pat@example.com', password: 'correct horse battery' });
    expect(signIn.status).toBe(200);
    expect(sessionCookie(signIn)).toBeTruthy();
  });

  it('refuses a wrong password, a short password and a taken email', async () => {
    await post('/api/auth/sign-up/email', { name: 'Sam', email: 'sam@example.com', password: 'a-good-password' });
    expect((await post('/api/auth/sign-in/email', { email: 'sam@example.com', password: 'wrong-password' })).status).toBe(401);
    expect((await post('/api/auth/sign-up/email', { name: 'X', email: 'x@example.com', password: 'short' })).status).toBe(400);
    const again = await post('/api/auth/sign-up/email', { name: 'Sam', email: 'sam@example.com', password: 'another-password' });
    expect(again.ok).toBe(false);
  });
});

describe('sign-in', () => {
  it('lists configured providers in display order', async () => {
    expect(await (await call('/api/account/providers')).json()).toEqual({
      providers: ['google', 'apple', 'github', 'discord'],
      email: true,
      passwordReset: false,
    });
    const { APPLE_PRIVATE_KEY: _key, DISCORD_CLIENT_SECRET: _secret, ...partial } = env;
    const res = await worker.fetch(new Request(`${ORIGIN}/api/account/providers`), partial as Env);
    expect(await res.json()).toEqual({ providers: ['google', 'github'], email: true, passwordReset: false });
  });

  it.each(['google', 'apple', 'github', 'discord'])('starts %s OAuth with state bound to this browser', async (provider) => {
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ provider, callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    const hosts: Record<string, string> = {
      google: 'accounts.google.com',
      apple: 'appleid.apple.com',
      github: 'github.com',
      discord: 'discord.com',
    };
    expect(authorize.hostname).toBe(hosts[provider]);
    if (provider === 'apple') expect(authorize.searchParams.get('response_mode')).toBe('form_post');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/${provider}`);
    expect(authorize.searchParams.get('state')).toBeTruthy();
    if (provider === 'google') expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Secure-worldmesh\./);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; HttpOnly/i);
      expect(cookie).toMatch(/; SameSite=Lax/i);
      expect(cookie).not.toMatch(/; Domain=/i);
    }
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('mints a valid Apple client secret from the .p8 key', async () => {
    const { appleClientSecret } = await import('../src/apple');
    const jwt = await appleClientSecret(env);
    const [header, payload, signature] = jwt.split('.');
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    const claims = decode(payload);
    expect(claims).toMatchObject({ iss: 'TEAM123456', sub: 'net.worldmesh.signin', aud: 'https://appleid.apple.com' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15_777_000); // Apple's six-month maximum
    const raw = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      applePublicKey,
      raw,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("turns Apple's cross-site form_post callback into a same-site GET", async () => {
    const form = (origin: string) =>
      call('/api/auth/callback/apple', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: origin,
          'Sec-Fetch-Site': 'cross-site',
          // A SameSite=None cookie (e.g. Cloudflare's bot cookie) still rides along.
          Cookie: '__cf_bm=abc',
        },
        body: 'code=abc&state=xyz',
      });
    const res = await form('https://appleid.apple.com');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/api/auth/callback/apple`);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect((await form('https://evil.example')).status).toBe(403);
  });

  it('refuses a callback URL on another origin (open redirect)', async () => {
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ provider: 'github', callbackURL: 'https://evil.example/' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses cookie-carrying requests from another site (CSRF)', async () => {
    const { cookie } = await signedInUser('csrf@example.com');
    for (const path of ['/api/auth/sign-in/social', '/api/auth/sign-out']) {
      const res = await call(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
          Cookie: cookie,
        },
        body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
      });
      expect(res.status).toBe(403);
    }
  });

  it('signs out and clears the session cookies', async () => {
    const { cookie } = await signedInUser('bye@example.com');
    const res = await call('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(c))).toBe(
      true,
    );
    const me = await call('/api/account/me', { headers: { Cookie: cookie } });
    expect(await me.json()).toEqual({ user: null });
  });

  it('rejects an OAuth callback without the matching state cookie', async () => {
    const res = await call('/api/auth/callback/github?code=abc&state=forged');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^https:\/\/worldmesh\.net\/\?auth=error/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(c))).toBe(
      false,
    );
  });
});

describe('/api/account', () => {
  it('reports a signed-out visitor as null, not an error', async () => {
    const res = await call('/api/account/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it('ignores a forged session cookie', async () => {
    const res = await call('/api/account/me', { headers: { Cookie: `${SESSION_COOKIE}=forged.c2lnbmF0dXJl` } });
    expect(await res.json()).toEqual({ user: null });
  });

  it('returns the signed-in user without their email', async () => {
    const { cookie } = await signedInUser('me@example.com');
    const res = await call('/api/account/me', { headers: { Cookie: cookie } });
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({ name: 'Test User', username: null, handle: null });
    expect(JSON.stringify(body)).not.toContain('me@example.com');
  });

  it('claims a username once, and only from our own origin', async () => {
    const { user, cookie } = await signedInUser('claim@example.com');
    const post = (username: string, origin = ORIGIN) =>
      call('/api/account/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ username }),
      });

    expect((await post('elias', 'https://evil.example')).status).toBe(403);
    expect((await post('no')).status).toBe(400);
    expect((await post('admin')).status).toBe(400);

    const res = await post('Elias');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: 'elias', handle: '@elias@worldmesh.net' } });
    // The session cookie cache is re-issued so the next page load sees the username.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Secure-worldmesh.session_data='))).toBe(true);

    expect((await post('elias2')).status).toBe(409);

    const profile = await env.DB.prepare('select user_id from profile where user_id = ?').bind(user.id).first();
    expect(profile).toEqual({ user_id: user.id });
  });

  it('keeps usernames unique', async () => {
    const first = await signedInUser('first@example.com');
    const second = await signedInUser('second@example.com');
    const post = (cookie: string) =>
      call('/api/account/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({ username: 'taken_name' }),
      });
    expect((await post(first.cookie)).status).toBe(200);
    const res = await post(second.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'That username is taken.' });
  });

  it('requires a session to claim a username', async () => {
    const res = await call('/api/account/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ username: 'nobody_here' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses oversized and non-JSON bodies', async () => {
    const { cookie } = await signedInUser('big@example.com');
    const headers = { Origin: ORIGIN, Cookie: cookie };
    const big = await call('/api/account/username', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    const form = await call('/api/account/username', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=elias',
    });
    expect(form.status).toBe(415);
  });
});

describe('stored identities', () => {
  it('never keeps provider tokens', async () => {
    const ctx = await createAuth(env).$context;
    const user = await ctx.internalAdapter.createUser({ name: 'T', email: 'tokens@example.com', emailVerified: true });
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: 'github',
      accountId: '12345',
      accessToken: 'gho_secret',
      refreshToken: 'refresh_secret',
      idToken: 'id_secret',
    });
    const row = await env.DB.prepare('select * from account where "userId" = ?').bind(user.id).first();
    expect(row).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, accountId: '12345' });
  });
});

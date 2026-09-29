/**
 * End to end against a real (local) D1 and a simulated remote Mastodon
 * server: discovery, Follow → signed Accept, announcing a world, interactions,
 * Undo, account deletion and delivery retries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createTestDatabase, type TestDatabase } from '../../../db/test/d1';
import worker, { type Env } from '../src/index';
import { generateActorKeys, importPrivateKey, importPublicKey } from '../src/crypto/keys';
import { signRequest, verifyRequest } from '../src/crypto/signatures';
import { runDeliveries } from '../src/delivery';

const ORIGIN = 'https://worldmesh.net';
const ADMIN_TOKEN = 'test-admin-token-1234567890';
const REMOTE = 'https://remote.social';
const ALICE = `${REMOTE}/users/alice`;

let database: TestDatabase;
let env: Env;
let alice: { keyId: string; privateKey: CryptoKey; publicKeyPem: string };
/** Everything our Worker POSTed to the remote server. */
let delivered: { url: string; request: Request; body: string }[] = [];
let remoteInboxStatus = 202;
const waitUntils: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => waitUntils.push(promise),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function settle() {
  while (waitUntils.length) await waitUntils.shift();
}

beforeAll(async () => {
  database = await createTestDatabase(getPlatformProxy as never);
  env = {
    DB: database.db,
    FEDERATION_ORIGIN: ORIGIN,
    FEDERATION_DOMAIN: 'worldmesh.net',
    FEDERATION_KEY_SECRET: 'federation-test-secret-federation-test',
    FEDERATION_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  const keys = await generateActorKeys();
  alice = {
    keyId: `${ALICE}#main-key`,
    privateKey: await importPrivateKey(keys.privateKeyPkcs8),
    publicKeyPem: keys.publicKeyPem,
  };

  // A creator who has claimed a username, as workers/auth leaves them.
  await env.DB.batch([
    env.DB.prepare(
      `insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", username)
       values ('u1', 'Elias', 'elias@example.com', 1, 'https://avatars.githubusercontent.com/u/1', ?1, ?1, 'elias')`,
    ).bind(new Date().toISOString()),
    env.DB.prepare(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ('u2', 'No Handle', 'nohandle@example.com', 1, ?1, ?1)`,
    ).bind(new Date().toISOString()),
    env.DB.prepare(`insert into profile (user_id, bio, created_at, updated_at) values ('u1', 'I build <worlds>.', 0, 0)`),
    env.DB.prepare(
      `insert into world (id, owner_user_id, name, url, description, cover_url, status, created_at, updated_at, published_at)
       values ('example-world-abc123', 'u1', 'Example World', 'https://example-world.pages.dev/', 'A test world.',
               'https://pub-b622cf770b414a1c9869157e73dab3c1.r2.dev/example.webp', 'published', 0, 0, 1700000000000),
              ('draft-world', 'u1', 'Draft', 'https://draft.pages.dev/', null, null, 'draft', 0, 0, null)`,
    ),
  ]);

  vi.stubGlobal('fetch', fakeRemote);
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await database?.dispose();
});

beforeEach(() => {
  delivered = [];
  remoteInboxStatus = 202;
});

/** The simulated remote server: serves Alice's actor, accepts inbox POSTs. */
async function fakeRemote(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = request.url;
  if (request.method === 'GET' && (url === ALICE || url === alice.keyId.replace(/#.*/, ''))) {
    expect(request.headers.get('Signature')).toMatch(/keyId="https:\/\/worldmesh\.net\/ap\/actors\/instance#main-key"/);
    return new Response(
      JSON.stringify({
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: ALICE,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${ALICE}/inbox`,
        endpoints: { sharedInbox: `${REMOTE}/inbox` },
        publicKey: { id: alice.keyId, owner: ALICE, publicKeyPem: alice.publicKeyPem },
      }),
      { headers: { 'Content-Type': 'application/activity+json; charset=utf-8' } },
    );
  }
  if (request.method === 'POST' && url.startsWith(REMOTE)) {
    delivered.push({ url, request: request.clone(), body: await request.text() });
    return new Response(null, { status: remoteInboxStatus });
  }
  return new Response('not found', { status: 404 });
}

function get(path: string, accept = 'application/activity+json') {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Accept: accept } }), env, ctx);
}

/** A POST to our inbox, signed by Alice the way Mastodon signs it. */
async function postAsAlice(path: string, activity: Record<string, unknown>, options: { now?: Date } = {}) {
  const body = JSON.stringify(activity);
  const headers = await signRequest({
    method: 'POST',
    url: `${ORIGIN}${path}`,
    headers: new Headers({ 'Content-Type': 'application/activity+json' }),
    body,
    keyId: alice.keyId,
    privateKey: alice.privateKey,
    now: options.now,
  });
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body }), env, ctx);
  await settle();
  return response;
}

async function actorPath(): Promise<{ path: string; uri: string }> {
  const res = await get('/.well-known/webfinger?resource=acct:elias@worldmesh.net', 'application/jrd+json');
  const jrd = (await res.json()) as { links: { rel: string; href: string }[] };
  const uri = jrd.links.find((link) => link.rel === 'self')!.href;
  return { uri, path: new URL(uri).pathname };
}

describe('discovery', () => {
  it('answers WebFinger for a creator with a username', async () => {
    const res = await get('/.well-known/webfinger?resource=acct:Elias@WorldMesh.net', 'application/jrd+json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^application\/jrd\+json/);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const jrd = (await res.json()) as Record<string, unknown>;
    expect(jrd.subject).toBe('acct:elias@worldmesh.net');
    expect(jrd.links).toContainEqual(expect.objectContaining({ rel: 'self', type: 'application/activity+json' }));
  });

  it.each([
    ['/.well-known/webfinger', 400],
    ['/.well-known/webfinger?resource=acct:nobody@worldmesh.net', 404],
    ['/.well-known/webfinger?resource=acct:elias@mastodon.social', 404],
    ['/.well-known/webfinger?resource=acct:elias@worldmesh.net&resource=acct:x@worldmesh.net', 400],
  ])('%s → %i', async (path, status) => {
    expect((await get(path)).status).toBe(status);
  });

  it('has no fediverse identity for users without a username', async () => {
    const count = await env.DB.prepare("select count(*) as n from ap_actor where user_id = 'u2'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('serves a Mastodon-compatible Person', async () => {
    const { path, uri } = await actorPath();
    const res = await get(path);
    expect(res.headers.get('Content-Type')).toMatch(/^application\/activity\+json/);
    const person = (await res.json()) as Record<string, any>;
    expect(person).toMatchObject({
      id: uri,
      type: 'Person',
      preferredUsername: 'elias',
      name: 'Elias',
      url: `${ORIGIN}/@elias`,
      inbox: `${uri}/inbox`,
      outbox: `${uri}/outbox`,
      followers: `${uri}/followers`,
      following: `${uri}/following`,
      endpoints: { sharedInbox: `${ORIGIN}/ap/inbox` },
      summary: '<p>I build &lt;worlds&gt;.</p>',
      icon: { type: 'Image', url: 'https://avatars.githubusercontent.com/u/1' },
    });
    expect(person.publicKey).toMatchObject({ id: `${uri}#main-key`, owner: uri });
    expect(person.publicKey.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(JSON.stringify(person)).not.toMatch(/PRIVATE|elias@example\.com/);
  });

  it('negotiates the profile URL: HTML for browsers, the actor for fediverse apps', async () => {
    const html = await get('/@elias', 'text/html');
    expect(html.headers.get('Content-Type')).toMatch(/^text\/html/);
    const page = await html.text();
    expect(page).toContain('@elias@worldmesh.net');
    expect(page).toContain('Example World');
    expect(page).not.toContain('Draft');
    expect(page).toContain('I build &lt;worlds&gt;.');
    const as = (await (await get('/@elias')).json()) as Record<string, unknown>;
    expect(as.type).toBe('Person');
  });

  it('serves NodeInfo', async () => {
    const links = (await (await get('/.well-known/nodeinfo', 'application/json')).json()) as { links: { href: string }[] };
    expect(links.links[0].href).toBe(`${ORIGIN}/nodeinfo/2.1`);
    const info = (await (await get('/nodeinfo/2.1', 'application/json')).json()) as Record<string, any>;
    expect(info.protocols).toEqual(['activitypub']);
  });
});

describe('Follow / Accept / Undo', () => {
  it('accepts a signed Follow and delivers a signed Accept to the follower', async () => {
    const { path, uri } = await actorPath();
    const follow = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${REMOTE}/follows/1`, type: 'Follow', actor: ALICE, object: uri };
    const res = await postAsAlice(`${path}/inbox`, follow);
    expect(res.status).toBe(202);

    const row = await env.DB.prepare('select * from ap_follower where follower_uri = ?').bind(ALICE).first();
    expect(row).toMatchObject({ follow_activity_id: `${REMOTE}/follows/1` });

    expect(delivered).toHaveLength(1);
    const [accept] = delivered;
    expect(accept.url).toBe(`${ALICE}/inbox`);
    expect(accept.request.headers.get('Content-Type')).toBe('application/activity+json');
    const body = JSON.parse(accept.body);
    expect(body).toMatchObject({ type: 'Accept', actor: uri, object: { id: `${REMOTE}/follows/1`, type: 'Follow', actor: ALICE, object: uri } });

    // The Accept carries a signature Mastodon can verify against our published key.
    const person = (await (await get(path)).json()) as { publicKey: { id: string; publicKeyPem: string } };
    const ourKey = await importPublicKey(person.publicKey.publicKeyPem);
    const verdict = await verifyRequest(accept.request, new TextEncoder().encode(accept.body), 'remote.social', async (keyId) =>
      keyId === person.publicKey.id ? { key: ourKey, owner: uri, fresh: true } : null,
    );
    expect(verdict.ok).toBe(true);

    const followers = (await (await get(`${path}/followers`)).json()) as { totalItems: number };
    expect(followers.totalItems).toBe(1);
  });

  it('ignores a replayed Follow (same id)', async () => {
    const { path, uri } = await actorPath();
    const res = await postAsAlice(`${path}/inbox`, { id: `${REMOTE}/follows/1`, type: 'Follow', actor: ALICE, object: uri });
    expect(res.status).toBe(202);
    expect(delivered).toHaveLength(0);
  });

  it('refuses unsigned, forged, stale and third-party activities', async () => {
    const { path, uri } = await actorPath();
    const follow = { id: `${REMOTE}/follows/2`, type: 'Follow', actor: ALICE, object: uri };

    const unsigned = await worker.fetch(
      new Request(`${ORIGIN}${path}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/activity+json' },
        body: JSON.stringify(follow),
      }),
      env,
      ctx,
    );
    expect(unsigned.status).toBe(401);

    const stale = await postAsAlice(`${path}/inbox`, follow, { now: new Date(Date.now() - 13 * 3600_000) });
    expect(stale.status).toBe(401);

    // Signed by Alice, claiming to be Bob.
    const spoof = await postAsAlice(`${path}/inbox`, { ...follow, id: `${REMOTE}/follows/3`, actor: `${REMOTE}/users/bob` });
    expect(spoof.status).toBe(401);

    // Alice's activity with an id on someone else's server.
    const foreign = await postAsAlice(`${path}/inbox`, { ...follow, id: 'https://elsewhere.social/follows/4' });
    expect(foreign.status).toBe(400);

    const wrongType = await worker.fetch(
      new Request(`${ORIGIN}${path}/inbox`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' }),
      env,
      ctx,
    );
    expect(wrongType.status).toBe(415);

    const huge = await postAsAlice(`${path}/inbox`, { ...follow, id: `${REMOTE}/follows/5`, padding: 'x'.repeat(300_000) });
    expect(huge.status).toBe(413);

    const count = await env.DB.prepare('select count(*) as n from ap_follower').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('removes the follower on Undo Follow', async () => {
    const { path, uri } = await actorPath();
    const res = await postAsAlice(`${path}/inbox`, {
      id: `${REMOTE}/undo/1`,
      type: 'Undo',
      actor: ALICE,
      object: { id: `${REMOTE}/follows/1`, type: 'Follow', actor: ALICE, object: uri },
    });
    expect(res.status).toBe(202);
    const count = await env.DB.prepare('select count(*) as n from ap_follower').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('announcing a world', () => {
  async function announce(worldId: string, token = ADMIN_TOKEN) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/ap/admin/announce`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId }),
      }),
      env,
      ctx,
    );
    await settle();
    return response;
  }

  it('requires the admin token', async () => {
    expect((await announce('example-world-abc123', 'wrong-token-wrong-token')).status).toBe(401);
  });

  it('refuses drafts', async () => {
    expect((await announce('draft-world')).status).toBe(409);
  });

  it('sends a Create(Note) to every follower inbox, once', async () => {
    const { path, uri } = await actorPath();
    await postAsAlice(`${path}/inbox`, { id: `${REMOTE}/follows/10`, type: 'Follow', actor: ALICE, object: uri });
    delivered = [];

    const res = await announce('example-world-abc123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true, deliveries: 1 });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].url).toBe(`${REMOTE}/inbox`); // the shared inbox
    const create = JSON.parse(delivered[0].body);
    expect(create).toMatchObject({
      type: 'Create',
      actor: uri,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${uri}/followers`],
      object: {
        type: 'Note',
        attributedTo: uri,
        url: `${ORIGIN}/@elias/worlds/example-world-abc123`,
        attachment: [{ type: 'Image', mediaType: 'image/webp' }],
      },
    });
    expect(create.object.content).toContain('Elias published');
    expect(create.object.content).toContain('Example World');
    expect(create.object.content).toContain('https://example-world.pages.dev/');

    // Dereferenceable, and listed in the outbox.
    const note = (await (await get(new URL(create.object.id).pathname)).json()) as Record<string, unknown>;
    expect(note.id).toBe(create.object.id);
    const page = (await (await get(`${path}/outbox?page=true`)).json()) as { orderedItems: { id: string }[] };
    expect(page.orderedItems.map((item) => item.id)).toEqual([create.id]);
    const canonical = (await (await get('/@elias/worlds/example-world-abc123')).json()) as Record<string, unknown>;
    expect(canonical.id).toBe(create.object.id);

    delivered = [];
    expect(await (await announce('example-world-abc123')).json()).toMatchObject({ created: false, deliveries: 0 });
    expect(delivered).toHaveLength(0);
  });

  it('records likes and boosts of the announcement, and their undo', async () => {
    const object = await env.DB.prepare("select id from ap_object where world_id = 'example-world-abc123'").first<{ id: string }>();
    const objectUri = `${ORIGIN}/ap/objects/${object!.id}`;
    await postAsAlice('/ap/inbox', { id: `${REMOTE}/likes/1`, type: 'Like', actor: ALICE, object: objectUri });
    await postAsAlice('/ap/inbox', { id: `${REMOTE}/boosts/1`, type: 'Announce', actor: ALICE, object: objectUri });
    await postAsAlice('/ap/inbox', {
      id: `${REMOTE}/creates/1`,
      type: 'Create',
      actor: ALICE,
      object: { id: `${REMOTE}/notes/1`, type: 'Note', attributedTo: ALICE, inReplyTo: objectUri, content: '<p>wow</p>' },
    });
    const counts = async () =>
      (await env.DB.prepare('select type, count(*) as n from ap_interaction group by type order by type').all()).results;
    expect(await counts()).toEqual([
      { type: 'Announce', n: 1 },
      { type: 'Like', n: 1 },
      { type: 'Reply', n: 1 },
    ]);

    await postAsAlice('/ap/inbox', {
      id: `${REMOTE}/undo/2`,
      type: 'Undo',
      actor: ALICE,
      object: { id: `${REMOTE}/likes/1`, type: 'Like', actor: ALICE, object: objectUri },
    });
    expect(await counts()).toEqual([
      { type: 'Announce', n: 1 },
      { type: 'Reply', n: 1 },
    ]);
  });

  it('forgets a deleted remote account entirely', async () => {
    const res = await postAsAlice('/ap/inbox', { id: `${ALICE}#delete`, type: 'Delete', actor: ALICE, object: ALICE });
    expect(res.status).toBe(202);
    for (const table of ['ap_follower', 'ap_interaction', 'ap_remote_actor']) {
      const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
  });
});

describe('delivery retries', () => {
  it('backs off on server errors and drops on permanent client errors', async () => {
    const activity = await env.DB.prepare("select id from ap_activity where type = 'Create'").first<{ id: string }>();
    await env.DB.prepare(
      `insert into ap_delivery (activity_id, inbox, next_attempt_at, created_at) values (?1, ?2, 0, 0), (?1, ?3, 0, 0)`,
    )
      .bind(activity!.id, `${REMOTE}/retry-inbox`, `${REMOTE}/gone-inbox`)
      .run();

    remoteInboxStatus = 503;
    expect(await runDeliveries(env, 1)).toBe(1);
    const retry = await env.DB.prepare('select attempts, next_attempt_at, last_error from ap_delivery where inbox = ?')
      .bind(`${REMOTE}/retry-inbox`)
      .first<{ attempts: number; next_attempt_at: number; last_error: string }>();
    expect(retry).toMatchObject({ attempts: 1, last_error: 'HTTP 503' });
    expect(retry!.next_attempt_at).toBeGreaterThan(Date.now());

    remoteInboxStatus = 410;
    expect(await runDeliveries(env, 5)).toBe(1); // only the one still due
    const left = await env.DB.prepare('select inbox from ap_delivery').all();
    expect(left.results).toEqual([{ inbox: `${REMOTE}/retry-inbox` }]);
  });
});

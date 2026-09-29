/**
 * Remote actors: fetched with a signed GET (so servers in Mastodon's "secure
 * mode" answer), validated, and cached in D1.
 */
import { ensureInstanceActor, signingKey } from './actors';
import { importPublicKey } from './crypto/keys';
import { signRequest, type KeyResolver } from './crypto/signatures';
import { ownHost, uris, type Env } from './env';
import {
  ACCEPT_ACTIVITY,
  assertPublicUrl,
  isActivityJson,
  parseJsonObject,
  safeFetch,
  UnsafeUrlError,
} from './net/safe-fetch';

export interface RemoteActor {
  uri: string;
  host: string;
  inbox: string;
  shared_inbox: string | null;
  key_id: string;
  public_key_pem: string;
  fetched_at: number;
}

const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Group', 'Organization']);
/** How long a cached key is trusted before a failing signature triggers a refetch. */
const KEY_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_PEM_LENGTH = 8 * 1024;

/** GETs an ActivityPub document, signed by our instance actor. */
export async function fetchActivityJson(env: Env, url: string): Promise<Record<string, unknown> | null> {
  const instance = await ensureInstanceActor(env);
  const key = await signingKey(env, instance);
  const response = await safeFetch(url, {
    ownHost: ownHost(env),
    init: async (target) => ({
      method: 'GET',
      headers: await signRequest({
        method: 'GET',
        url: target.toString(),
        headers: new Headers({ Accept: ACCEPT_ACTIVITY, 'User-Agent': userAgent(env) }),
        keyId: uris.key(env, instance.id),
        privateKey: key,
      }),
    }),
  });
  if (response.status !== 200 || !isActivityJson(response.headers.get('Content-Type'))) return null;
  return parseJsonObject(response.body);
}

export function userAgent(env: Env): string {
  return `WorldMesh (+${env.FEDERATION_ORIGIN})`;
}

/**
 * Validates an actor document fetched from `fetchedFrom`. The document must
 * describe itself at that exact id, and its key must be owned by it.
 */
export function parseActor(env: Env, doc: Record<string, unknown>, fetchedFrom: string, keyId?: string): RemoteActor | null {
  const id = doc.id;
  if (typeof id !== 'string' || id !== fetchedFrom) return null;
  if (typeof doc.type !== 'string' || !ACTOR_TYPES.has(doc.type)) return null;
  let actorUrl: URL;
  let inbox: URL;
  try {
    actorUrl = assertPublicUrl(id, ownHost(env));
    inbox = assertPublicUrl(String(doc.inbox), ownHost(env));
  } catch {
    return null;
  }
  // Inboxes live on the actor's own host. Otherwise anyone could point us at
  // an arbitrary URL and have us POST signed requests to it.
  if (inbox.host !== actorUrl.host) return null;
  let sharedInbox: string | null = null;
  const endpoints = doc.endpoints as Record<string, unknown> | undefined;
  if (endpoints && typeof endpoints === 'object' && typeof endpoints.sharedInbox === 'string') {
    try {
      const shared = assertPublicUrl(endpoints.sharedInbox, ownHost(env));
      sharedInbox = shared.host === actorUrl.host ? shared.toString() : null;
    } catch {
      sharedInbox = null;
    }
  }

  const keys = (Array.isArray(doc.publicKey) ? doc.publicKey : [doc.publicKey]).filter(
    (key): key is Record<string, unknown> => !!key && typeof key === 'object',
  );
  const key = keys.find((candidate) => (keyId ? candidate.id === keyId : true));
  if (!key || typeof key.id !== 'string' || key.owner !== id) return null;
  if (typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > MAX_PEM_LENGTH) return null;

  return {
    uri: id,
    host: actorUrl.host,
    inbox: inbox.toString(),
    shared_inbox: sharedInbox,
    key_id: key.id,
    public_key_pem: key.publicKeyPem,
    fetched_at: Date.now(),
  };
}

export async function upsertRemoteActor(db: D1Database, actor: RemoteActor): Promise<void> {
  // An upsert, never `insert or replace`: a replace would cascade-delete followers.
  await db
    .prepare(
      `insert into ap_remote_actor (uri, host, inbox, shared_inbox, key_id, public_key_pem, fetched_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       on conflict (uri) do update set host = ?2, inbox = ?3, shared_inbox = ?4, key_id = ?5,
         public_key_pem = ?6, fetched_at = ?7`,
    )
    .bind(actor.uri, actor.host, actor.inbox, actor.shared_inbox, actor.key_id, actor.public_key_pem, actor.fetched_at)
    .run();
}

/** Fetches (or reads from cache) the remote actor at `uri`. */
export async function getRemoteActor(env: Env, uri: string, refresh = false): Promise<RemoteActor | null> {
  if (!refresh) {
    const cached = await env.DB.prepare('select * from ap_remote_actor where uri = ?').bind(uri).first<RemoteActor>();
    if (cached && Date.now() - cached.fetched_at < KEY_CACHE_MS) return cached;
  }
  const doc = await fetchActivityJson(env, uri).catch(ignoreUnsafe);
  const actor = doc && parseActor(env, doc, uri);
  if (actor) await upsertRemoteActor(env.DB, actor);
  return actor;
}

/**
 * Resolves the key named in an incoming signature. The key id is normally
 * `<actor>#main-key`; the actor is fetched from the part before the fragment
 * and must list that exact key as its own.
 */
export function keyResolver(env: Env): KeyResolver {
  return async (keyId, refresh) => {
    let actorUri: string;
    try {
      const url = assertPublicUrl(keyId, ownHost(env));
      url.hash = '';
      actorUri = url.toString();
    } catch {
      return null;
    }

    let actor: RemoteActor | null = null;
    let fresh = refresh;
    if (!refresh) {
      actor = await env.DB.prepare('select * from ap_remote_actor where key_id = ?').bind(keyId).first<RemoteActor>();
      if (actor && Date.now() - actor.fetched_at >= KEY_CACHE_MS) actor = null;
    }
    if (!actor) {
      let doc = await fetchActivityJson(env, actorUri).catch(ignoreUnsafe);
      // Some servers (e.g. GoToSocial) use a key URL without a fragment, which
      // serves the key or a stub naming its owner. Follow that once, same host only.
      if (doc && doc.id !== actorUri) {
        const owner = typeof doc.owner === 'string' ? doc.owner : typeof doc.id === 'string' ? doc.id : null;
        actorUri = owner && sameHost(owner, keyId) ? owner : '';
        doc = actorUri ? await fetchActivityJson(env, actorUri).catch(ignoreUnsafe) : null;
      }
      actor = doc ? parseActor(env, doc, actorUri, keyId) : null;
      if (!actor) return null;
      await upsertRemoteActor(env.DB, actor);
      fresh = true;
    }
    try {
      return { key: await importPublicKey(actor.public_key_pem), owner: actor.uri, fresh };
    } catch {
      return null;
    }
  };
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

function ignoreUnsafe(error: unknown): null {
  if (error instanceof UnsafeUrlError) return null;
  // Timeouts, DNS failures, oversized documents: the remote is unusable right now.
  console.warn('remote fetch failed', String(error));
  return null;
}

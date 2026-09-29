/**
 * Local actors. A WorldMesh creator becomes a Person the first time
 * federation needs them (WebFinger, a Follow, an announcement), and only once
 * they have claimed a username. The instance actor (an Application) signs our
 * server-to-server GETs, as Mastodon's does.
 */
import { AS_CONTEXT, origin, randomId, uris, type Env } from './env';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  generateActorKeys,
  importPrivateKey,
} from './crypto/keys';

export const INSTANCE_ACTOR_ID = 'instance';

export interface LocalActor {
  id: string;
  kind: 'person' | 'application' | 'world';
  user_id: string | null;
  public_key_pem: string;
  private_key_enc: string;
  created_at: number;
}

/** A creator as federation sees them: Better Auth's user row plus the profile. */
export interface Creator {
  user_id: string;
  username: string;
  name: string;
  image: string | null;
  bio: string | null;
  website_url: string | null;
  avatar_url: string | null;
  created_at: string;
}

// Apple users may have no name at all; the handle stands in for it.
const CREATOR_COLUMNS = `u.id as user_id, u.username, coalesce(nullif(trim(u.name), ''), u.username) as name,
  u.image, u."createdAt" as created_at,
  p.bio, p.website_url, p.avatar_url`;

export async function findCreatorByUsername(db: D1Database, username: string): Promise<Creator | null> {
  if (!/^[a-z][a-z0-9_]{2,29}$/.test(username)) return null;
  return db
    .prepare(`select ${CREATOR_COLUMNS} from "user" u left join profile p on p.user_id = u.id where u.username = ?`)
    .bind(username)
    .first<Creator>();
}

export async function findCreatorByActorId(
  db: D1Database,
  actorId: string,
): Promise<{ actor: LocalActor; creator: Creator | null } | null> {
  const actor = await db.prepare('select * from ap_actor where id = ?').bind(actorId).first<LocalActor>();
  if (!actor) return null;
  if (actor.kind !== 'person' || !actor.user_id) return { actor, creator: null };
  const creator = await db
    .prepare(`select ${CREATOR_COLUMNS} from "user" u left join profile p on p.user_id = u.id where u.id = ?`)
    .bind(actor.user_id)
    .first<Creator>();
  // A person whose username was removed is no longer published.
  return creator?.username ? { actor, creator } : null;
}

export async function ensurePersonActor(env: Env, userId: string): Promise<LocalActor> {
  const existing = await env.DB.prepare('select * from ap_actor where user_id = ?').bind(userId).first<LocalActor>();
  if (existing) return existing;
  return createActor(env, randomId(), 'person', userId);
}

export async function ensureInstanceActor(env: Env): Promise<LocalActor> {
  const existing = await env.DB.prepare('select * from ap_actor where id = ?')
    .bind(INSTANCE_ACTOR_ID)
    .first<LocalActor>();
  return existing ?? createActor(env, INSTANCE_ACTOR_ID, 'application', null);
}

/**
 * Generating an RSA key costs ~50–200 ms of CPU: more than the free plan's
 * 10 ms per request, which Workers tolerate occasionally. It happens once per
 * actor. Concurrent first requests race harmlessly: the loser's insert is
 * ignored and everyone reads the winner's row.
 */
async function createActor(env: Env, id: string, kind: LocalActor['kind'], userId: string | null): Promise<LocalActor> {
  const keys = await generateActorKeys();
  const encrypted = await encryptPrivateKey(env.FEDERATION_KEY_SECRET, id, keys.privateKeyPkcs8);
  await env.DB.prepare(
    `insert into ap_actor (id, kind, user_id, public_key_pem, private_key_enc, created_at)
     values (?1, ?2, ?3, ?4, ?5, ?6) on conflict do nothing`,
  )
    .bind(id, kind, userId, keys.publicKeyPem, encrypted, Date.now())
    .run();
  const row = await env.DB.prepare(userId ? 'select * from ap_actor where user_id = ?' : 'select * from ap_actor where id = ?')
    .bind(userId ?? id)
    .first<LocalActor>();
  if (!row) throw new Error('Actor creation failed');
  return row;
}

// Resolved keys only: a promise begun in one request must not be awaited by another.
const signingKeys = new Map<string, CryptoKey>();

export async function signingKey(env: Env, actor: LocalActor): Promise<CryptoKey> {
  const cacheKey = `${actor.id}:${actor.private_key_enc.slice(-16)}`;
  const cachedKey = signingKeys.get(cacheKey);
  if (cachedKey) return cachedKey;
  const key = await importPrivateKey(await decryptPrivateKey(env.FEDERATION_KEY_SECRET, actor.id, actor.private_key_enc));
  signingKeys.set(cacheKey, key);
  return key;
}

// ── Documents ───────────────────────────────────────────────────────────────

const ACTOR_CONTEXT = [
  AS_CONTEXT,
  'https://w3id.org/security/v1',
  {
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    toot: 'http://joinmastodon.org/ns#',
    discoverable: 'toot:discoverable',
    indexable: 'toot:indexable',
    webfinger: 'https://purl.archive.org/socialweb/webfinger#webfinger',
  },
];

export function personDocument(env: Env, actor: LocalActor, creator: Creator): Record<string, unknown> {
  const id = uris.actor(env, actor.id);
  const icon = creator.avatar_url || creator.image;
  let summary = '';
  if (creator.bio) summary += `<p>${escapeHtml(creator.bio)}</p>`;
  if (creator.website_url) summary += `<p>${linkHtml(creator.website_url)}</p>`;
  return {
    '@context': ACTOR_CONTEXT,
    id,
    type: 'Person',
    preferredUsername: creator.username,
    webfinger: `${creator.username}@${env.FEDERATION_DOMAIN}`,
    name: creator.name,
    summary: summary || '<p>Creator on WorldMesh.</p>',
    url: uris.profile(env, creator.username),
    inbox: uris.inbox(env, actor.id),
    outbox: uris.outbox(env, actor.id),
    followers: uris.followers(env, actor.id),
    following: uris.following(env, actor.id),
    endpoints: { sharedInbox: uris.sharedInbox(env) },
    ...(icon && /^https:\/\//.test(icon) ? { icon: { type: 'Image', url: icon } } : {}),
    manuallyApprovesFollowers: false,
    // They chose a public creator handle; full-text search stays opt-in.
    discoverable: true,
    indexable: false,
    published: new Date(creator.created_at).toISOString(),
    publicKey: { id: uris.key(env, actor.id), owner: id, publicKeyPem: actor.public_key_pem },
  };
}

export function instanceDocument(env: Env, actor: LocalActor): Record<string, unknown> {
  const id = uris.actor(env, actor.id);
  return {
    '@context': ACTOR_CONTEXT,
    id,
    type: 'Application',
    preferredUsername: env.FEDERATION_DOMAIN,
    name: 'WorldMesh',
    summary: '<p>The WorldMesh server itself. It signs requests; it does not post.</p>',
    url: `${origin(env)}/`,
    inbox: uris.inbox(env, actor.id),
    outbox: uris.outbox(env, actor.id),
    followers: uris.followers(env, actor.id),
    following: uris.following(env, actor.id),
    endpoints: { sharedInbox: uris.sharedInbox(env) },
    manuallyApprovesFollowers: true,
    discoverable: false,
    indexable: false,
    publicKey: { id: uris.key(env, actor.id), owner: id, publicKeyPem: actor.public_key_pem },
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function linkHtml(href: string, text?: string): string {
  const safe = /^https?:\/\//i.test(href) ? href : '#';
  const label = text ?? href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `<a href="${escapeHtml(safe)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(label)}</a>`;
}

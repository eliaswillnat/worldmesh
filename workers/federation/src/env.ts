export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** Base of every URI we mint, e.g. https://worldmesh.net. */
  FEDERATION_ORIGIN: string;
  /** Domain in handles, @username@FEDERATION_DOMAIN. */
  FEDERATION_DOMAIN: string;
  FEDERATION_KEY_SECRET: string;
  FEDERATION_ADMIN_TOKEN?: string;
  DELIVERY_BATCH_SIZE?: string;
  INBOX_LIMITER?: RateLimiter;
}

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

export function origin(env: Env): string {
  return env.FEDERATION_ORIGIN.replace(/\/+$/, '');
}

export function ownHost(env: Env): string {
  return new URL(env.FEDERATION_ORIGIN).host;
}

export const uris = {
  actor: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}`,
  key: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}#main-key`,
  inbox: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}/inbox`,
  outbox: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}/outbox`,
  followers: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}/followers`,
  following: (env: Env, id: string) => `${origin(env)}/ap/actors/${id}/following`,
  sharedInbox: (env: Env) => `${origin(env)}/ap/inbox`,
  object: (env: Env, id: string) => `${origin(env)}/ap/objects/${id}`,
  activity: (env: Env, id: string) => `${origin(env)}/ap/activities/${id}`,
  profile: (env: Env, username: string) => `${origin(env)}/@${username}`,
  worldPage: (env: Env, username: string, worldId: string) => `${origin(env)}/@${username}/worlds/${encodeURIComponent(worldId)}`,
};

/** The local id in one of our own URIs, e.g. actorIdFromUri(env, '.../ap/actors/abc') === 'abc'. */
export function localId(env: Env, kind: 'actors' | 'objects' | 'activities', uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  const prefix = `${origin(env)}/ap/${kind}/`;
  if (!uri.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  return /^[a-z0-9-]{1,64}$/.test(id) ? id : null;
}

/** Random lowercase id for URIs we mint: 128 bits, base32. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

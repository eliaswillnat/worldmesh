/**
 * Vouching for avatar links shown to other players.
 *
 * When a world resolves a visitor's avatar, the hub also signs its model link
 * (Ed25519). The visitor's page passes the signed link to everyone else in the
 * room, and their browsers download the model only if the signature checks out
 * against the hub's public key. A link someone made up (say, to a server of
 * their own that logs who fetches it) is never fetched by anyone else.
 *
 * Only links WorldMesh got from a platform itself are signed:
 * - Sketchfab: the presigned URL Sketchfab's API returned.
 * - at3d: a blob on a well-known AT Protocol host (PUBLIC_PDS_HOSTS). A
 *   self-hosted PDS is the owner's own server, so its avatars stay visible to
 *   their owner only.
 * - VRoid Hub: never. Its download license is for the user who asked for it;
 *   showing it to other players needs VRoid's "Multiplay" approval.
 *
 * The key pair is derived from AVATAR_SECRET, so there is nothing more to set up.
 */
import { base64url, utf8 } from './crypto';
import type { AvatarDescriptor } from './types';

/** What other players receive: link, format, a short stable id, expiry (unix seconds), signature. */
export interface SignedShare {
  u: string;
  f: string;
  i: string;
  x: number;
  s: string;
}

/** Bluesky's PDS hosts. Other at3d hosts are not vouched for. */
const PUBLIC_PDS_HOSTS: readonly ((host: string) => boolean)[] = [
  (host) => host === 'bsky.social',
  (host) => host.endsWith('.host.bsky.network'),
];
/** Longest a signature lasts; the owner's page asks for a new one before it runs out. */
const SHARE_TTL_SECONDS = 2 * 60 * 60;
const CONTEXT = 'worldmesh-avatar-share-v1';
/** PKCS#8 header of a raw 32-byte Ed25519 private key. */
const PKCS8_ED25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

// Resolved keys only: a promise begun in one request must not be awaited by another.
const keys = new Map<string, { privateKey: CryptoKey; publicJwk: JsonWebKey }>();

async function keyPair(secret: string | undefined): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  if (!secret || secret.length < 32) throw new Error('AVATAR_SECRET must be at least 32 characters.');
  const cached = keys.get(secret);
  if (cached) return cached;
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8('worldmesh-avatar-wallet'), info: utf8('share-signing-v1') }, material, 256),
  );
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + seed.length);
  pkcs8.set(PKCS8_ED25519);
  pkcs8.set(seed, PKCS8_ED25519.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const { kty, crv, x } = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  const pair = { privateKey, publicJwk: { kty, crv, x } };
  keys.set(secret, pair);
  return pair;
}

/** The public key worlds check signatures with. */
export async function shareKey(secret: string | undefined): Promise<JsonWebKey> {
  return (await keyPair(secret)).publicJwk;
}

/** The exact bytes signed. The runtime builds the same string to verify. */
export function sharePayload(u: string, f: string, i: string, x: number): Uint8Array {
  return utf8(`${CONTEXT}\n${u}\n${f}\n${i}\n${x}`);
}

/** Whether other players may be shown this avatar from this link. */
export function mayShare(descriptor: AvatarDescriptor): boolean {
  let url: URL;
  try {
    url = new URL(descriptor.modelUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  switch (descriptor.provider) {
    case 'sketchfab':
      return true;
    case 'atproto': {
      const host = url.hostname.toLowerCase();
      return PUBLIC_PDS_HOSTS.some((matches) => matches(host));
    }
    default:
      return false;
  }
}

/** A signed link to this avatar for other players, or null when it must not be shared. */
export async function signShare(secret: string | undefined, descriptor: AvatarDescriptor, now = Date.now()): Promise<SignedShare | null> {
  if (!mayShare(descriptor)) return null;
  const linkExpires = descriptor.expiresAt ? Math.floor(Date.parse(descriptor.expiresAt) / 1000) : Infinity;
  const x = Math.min(Math.floor(now / 1000) + SHARE_TTL_SECONDS, Number.isFinite(linkExpires) ? linkExpires : Infinity);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`${descriptor.provider}:${descriptor.avatarId}`)));
  const i = [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { privateKey } = await keyPair(secret);
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, sharePayload(descriptor.modelUrl, descriptor.format, i, x));
  return { u: descriptor.modelUrl, f: descriptor.format, i, x, s: base64url(new Uint8Array(signature)) };
}

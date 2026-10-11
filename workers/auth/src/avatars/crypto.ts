/**
 * Everything the Avatar Wallet keeps secret is sealed with AES-256-GCM under
 * keys derived (HKDF) from the AVATAR_SECRET Worker secret, one key per
 * purpose. A copy of D1 alone reveals no provider token, and a handoff ticket
 * reveals nothing about who it belongs to.
 */

export type Purpose = 'provider-token-v1' | 'oauth-flow-v1' | 'handoff-v1' | 'upload-grant-v1';

// Resolved keys only: a promise begun in one request must not be awaited by another.
const keys = new Map<string, CryptoKey>();

async function keyFor(secret: string | undefined, purpose: Purpose): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('AVATAR_SECRET must be at least 32 characters.');
  const cacheKey = `${purpose}\n${secret}`;
  const cached = keys.get(cacheKey);
  if (cached) return cached;
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('worldmesh-avatar-wallet'), info: utf8(purpose) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keys.set(cacheKey, key);
  return key;
}

/** Encrypts `value` as JSON. `context` is bound as associated data (e.g. the connection id). */
export async function seal(secret: string | undefined, purpose: Purpose, context: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(context) },
    await keyFor(secret, purpose),
    utf8(JSON.stringify(value)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

/** The sealed value, or null for anything forged, tampered with or sealed for another context. */
export async function open<T>(secret: string | undefined, purpose: Purpose, context: string, sealed: string): Promise<T | null> {
  const [iv, ciphertext, extra] = sealed.split('.');
  if (!iv || !ciphertext || extra !== undefined) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(iv), additionalData: utf8(context) },
      await keyFor(secret, purpose),
      fromBase64url(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AVATAR_SECRET')) throw error;
    return null;
  }
}

/** A URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

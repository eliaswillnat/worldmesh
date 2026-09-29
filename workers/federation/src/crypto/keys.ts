/**
 * Actor key pairs: RSA-2048 / RSASSA-PKCS1-v1_5 / SHA-256, the only
 * combination every ActivityPub server in use today can verify.
 *
 * Private keys never sit in D1 in the clear. They are encrypted with
 * AES-256-GCM under a key derived (HKDF) from the FEDERATION_KEY_SECRET
 * Worker secret, with the actor id as associated data so a ciphertext cannot
 * be moved to another actor's row.
 */

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export interface GeneratedKeys {
  publicKeyPem: string;
  privateKeyPkcs8: ArrayBuffer;
}

export async function generateActorKeys(): Promise<GeneratedKeys> {
  const pair = (await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  return { publicKeyPem: pemEncode('PUBLIC KEY', spki), privateKeyPkcs8: pkcs8 };
}

export function importPrivateKey(pkcs8: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, RSA, false, ['sign']);
}

/** Imports a remote actor's SPKI ("BEGIN PUBLIC KEY") RSA key. Anything else is refused. */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemDecode(pem, 'PUBLIC KEY'), RSA, false, ['verify']);
}

export function sign(key: CryptoKey, data: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign(RSA.name, key, new TextEncoder().encode(data));
}

export function verify(key: CryptoKey, signature: Uint8Array, data: string): Promise<boolean> {
  return crypto.subtle.verify(RSA.name, key, signature, new TextEncoder().encode(data));
}

export function pemEncode(label: string, der: ArrayBuffer): string {
  const lines = toBase64(new Uint8Array(der)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function pemDecode(pem: string, label: string): ArrayBuffer {
  const match = pem.match(new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`));
  if (!match) throw new Error(`Not a ${label} PEM`);
  return fromBase64(match[1].replace(/\s+/g, '')).buffer as ArrayBuffer;
}

// ── Private key encryption at rest ──────────────────────────────────────────

// Resolved keys only: a promise begun in one request must not be awaited by another.
const wrappingKeys = new Map<string, CryptoKey>();

async function wrappingKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('FEDERATION_KEY_SECRET must be at least 32 characters.');
  const cachedKey = wrappingKeys.get(secret);
  if (cachedKey) return cachedKey;
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('worldmesh-federation'),
      info: new TextEncoder().encode('actor-private-key-v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  wrappingKeys.set(secret, key);
  return key;
}

export async function encryptPrivateKey(secret: string, actorId: string, pkcs8: ArrayBuffer): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(actorId) },
    await wrappingKey(secret),
    pkcs8,
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptPrivateKey(secret: string, actorId: string, stored: string): Promise<ArrayBuffer> {
  const [version, iv, ciphertext] = stored.split('.');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unknown private key format');
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: new TextEncoder().encode(actorId) },
    await wrappingKey(secret),
    fromBase64(ciphertext),
  );
}

// ── Encoding ────────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Base64(body: Uint8Array | string): Promise<string> {
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** Compares two strings in time independent of where they differ. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Base64(a), sha256Base64(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

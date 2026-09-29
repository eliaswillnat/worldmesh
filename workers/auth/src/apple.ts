/**
 * Sign in with Apple has no static client secret: it is an ES256 JWT signed
 * with the .p8 key from the Apple Developer account, valid for at most six
 * months. Minting it here means no secret to rotate by hand.
 * https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
 */

export interface AppleCredentials {
  /** The Services ID, e.g. net.worldmesh.signin — the OAuth client id. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Contents of AuthKey_<KEY_ID>.p8 (PKCS#8 PEM). */
  APPLE_PRIVATE_KEY?: string;
}

const LIFETIME_S = 2 * 24 * 60 * 60;
const RENEW_BEFORE_S = 24 * 60 * 60;

// Resolved strings only: a promise begun in one request must not be awaited by another.
let cached: { key: string; secret: string; expiresAt: number } | null = null;

export function appleConfigured(env: AppleCredentials): boolean {
  return !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

export async function appleClientSecret(env: AppleCredentials, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const { APPLE_CLIENT_ID: sub, APPLE_TEAM_ID: iss, APPLE_KEY_ID: kid, APPLE_PRIVATE_KEY: pem } = env;
  if (!sub || !iss || !kid || !pem) throw new Error('Apple sign-in is not configured.');
  const cacheKey = `${sub}:${iss}:${kid}`;
  if (cached?.key === cacheKey && cached.expiresAt - now > RENEW_BEFORE_S) return cached.secret;

  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  const exp = now + LIFETIME_S;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid }));
  const payload = base64url(JSON.stringify({ iss, iat: now, exp, aud: 'https://appleid.apple.com', sub }));
  // WebCrypto's ECDSA output is already the raw r||s form JWS expects.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const secret = `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
  cached = { key: cacheKey, secret, expiresAt: exp };
  return secret;
}

function pemToDer(pem: string): ArrayBuffer {
  // Secrets pasted through a dashboard sometimes arrive with literal "\n".
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

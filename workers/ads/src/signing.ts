/**
 * HMAC-signed, expiring links to a submission's files (for the moderation
 * email, which an email client fetches without any session), and CSRF tokens
 * for the admin forms. Keyed by ADS_SIGNING_SECRET, which never leaves the Worker.
 */
import { hmacHex, timingSafeEqual } from './crypto';
import { origin, type Env } from './env';

export type MediaVariant = 'media' | 'poster';

function mediaMessage(id: string, variant: MediaVariant, expires: number): string {
  return `media:${id}:${variant}:${expires}`;
}

export async function signedMediaUrl(env: Env, id: string, variant: MediaVariant, expires: number): Promise<string> {
  const exp = Math.floor(expires / 1000);
  const sig = await hmacHex(env.ADS_SIGNING_SECRET, mediaMessage(id, variant, exp));
  return `${origin(env)}/api/ads/media/${encodeURIComponent(id)}/${variant}?exp=${exp}&sig=${sig}`;
}

export async function verifyMediaSignature(env: Env, id: string, variant: MediaVariant, url: URL, nowMs: number): Promise<boolean> {
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!Number.isInteger(exp) || exp * 1000 < nowMs || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(sig, await hmacHex(env.ADS_SIGNING_SECRET, mediaMessage(id, variant, exp)));
}

/** Bound to the admin's session and the submission, so a token is useless anywhere else. */
export function csrfToken(env: Env, sessionToken: string, adId: string): Promise<string> {
  return hmacHex(env.ADS_SIGNING_SECRET, `csrf:${sessionToken}:${adId}`);
}

export async function verifyCsrfToken(env: Env, sessionToken: string, adId: string, presented: unknown): Promise<boolean> {
  return typeof presented === 'string' && timingSafeEqual(presented, await csrfToken(env, sessionToken, adId));
}

/**
 * Presence tickets: proof that the name above an avatar belongs to a
 * signed-in account.
 *
 * workers/auth signs one for a signed-in user with a username; the hub puts it
 * on the room's WebSocket URL; this worker checks it once, when the socket
 * opens. Both sides share PRESENCE_SECRET and nothing else: the ticket carries
 * the username and an expiry, never a session or a user id.
 *
 *   ticket = base64url(JSON { u: username, exp: unix seconds }) "." base64url(HMAC-SHA256)
 *
 * This file is the one definition of the format. workers/auth imports
 * `signPresenceTicket` from here.
 */

/** How long a ticket can be used to open a socket. The socket itself may stay open longer. */
export const PRESENCE_TICKET_TTL_S = 10 * 60;
/** Same shape as workers/auth USERNAME_PATTERN. */
const USERNAME = /^[a-z][a-z0-9_]{2,29}$/;
/** Bound into every signature, so a key reused elsewhere cannot mint tickets. */
const PURPOSE = 'worldmesh-presence-ticket-v1';
const MAX_TICKET_LENGTH = 256;

// Resolved keys only: a promise begun in one request must not be awaited by another.
const keys = new Map<string, CryptoKey>();

async function keyFor(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('PRESENCE_SECRET must be at least 32 characters.');
  const cached = keys.get(secret);
  if (cached) return cached;
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  keys.set(secret, key);
  return key;
}

export async function signPresenceTicket(
  secret: string,
  username: string,
  now = Date.now(),
): Promise<string> {
  if (!USERNAME.test(username)) throw new Error('Not a username.');
  const payload = base64url(utf8(JSON.stringify({ u: username, exp: Math.floor(now / 1000) + PRESENCE_TICKET_TTL_S })));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), utf8(`${PURPOSE}.${payload}`));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The username a ticket vouches for, or null for anything forged, expired or malformed. */
export async function verifyPresenceTicket(
  secret: string,
  ticket: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!ticket || ticket.length > MAX_TICKET_LENGTH) return null;
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await keyFor(secret),
      fromBase64url(signature),
      utf8(`${PURPOSE}.${payload}`),
    );
    if (!valid) return null;
    const { u, exp } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { u?: unknown; exp?: unknown };
    if (typeof u !== 'string' || !USERNAME.test(u)) return null;
    if (typeof exp !== 'number' || exp * 1000 <= now) return null;
    return u;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PRESENCE_SECRET')) throw error;
    return null;
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

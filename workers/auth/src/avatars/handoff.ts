/**
 * Avatar handoff tickets: how a world on another host learns which avatar to
 * render without learning anything else.
 *
 * The hub mints a ticket for the signed-in user and appends it to a world's
 * URL as a fragment (#wm-avatar=…), which browsers never send to servers or
 * in Referer headers. The world's runtime removes it from the address bar,
 * keeps it in sessionStorage, exchanges it at POST /api/account/avatar/resolve
 * for a descriptor, and forwards it through portals so the avatar follows.
 *
 * A ticket is sealed (AES-GCM), so it is opaque: it carries the user id and an
 * expiry, and nobody but this Worker can read or forge one. It is a bearer
 * reference to "whatever avatar this user has selected right now", never a
 * credential: it cannot reach the account, the session or any provider token.
 * Choosing "Continue without character" or disconnecting a provider makes
 * every outstanding ticket resolve to nothing at once.
 */
import { open, seal } from './crypto';

/** Long enough for an evening of world hopping; the hub mints a fresh one on every visit. */
export const TICKET_TTL_SECONDS = 12 * 60 * 60;
const CONTEXT = 'avatar-handoff';

interface TicketPayload {
  u: string;
  /** Unix seconds. */
  exp: number;
}

export async function mintTicket(secret: string | undefined, userId: string): Promise<{ ticket: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const ticket = await seal(secret, 'handoff-v1', CONTEXT, { u: userId, exp } satisfies TicketPayload);
  return { ticket, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The user id a ticket was minted for, or null if it is forged or expired. */
export async function readTicket(secret: string | undefined, ticket: unknown): Promise<string | null> {
  if (typeof ticket !== 'string' || ticket.length > 512) return null;
  const payload = await open<TicketPayload>(secret, 'handoff-v1', CONTEXT, ticket);
  if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  return payload.exp > Date.now() / 1000 ? payload.u : null;
}

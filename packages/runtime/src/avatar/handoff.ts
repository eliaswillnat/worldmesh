import { parseAvatarDescriptor, type AvatarDescriptor } from './descriptor.js';

/**
 * Carrying a visitor's chosen avatar between worlds.
 *
 * The WorldMesh hub appends an opaque, short-lived ticket to a world's URL as
 * a fragment (`#wm-avatar=…`): fragments are never sent to servers or in
 * Referer headers. The runtime takes it out of the address bar (so it is not
 * bookmarked or shared), keeps it in sessionStorage for this tab, and adds it
 * again to portal destinations so the avatar follows the visitor.
 *
 * A ticket only ever resolves to an avatar descriptor. It carries no session,
 * no account and no platform credentials.
 */

export const AVATAR_TICKET_PARAM = 'wm-avatar';
/** sessionStorage key. The hub writes the same key. */
export const AVATAR_TICKET_STORAGE_KEY = 'worldmesh.avatarTicket';
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{16,512}$/;

/** Moves a ticket from this page's URL fragment into storage, and returns the current one. */
export function takeAvatarTicket(): string | null {
  const hash = window.location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const ticket = params.get(AVATAR_TICKET_PARAM);
    if (ticket !== null) {
      params.delete(AVATAR_TICKET_PARAM);
      const rest = params.toString();
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
      if (TICKET_PATTERN.test(ticket)) setAvatarTicket(ticket);
    }
  }
  return getAvatarTicket();
}

export function getAvatarTicket(): string | null {
  try {
    const ticket = sessionStorage.getItem(AVATAR_TICKET_STORAGE_KEY);
    return ticket && TICKET_PATTERN.test(ticket) ? ticket : null;
  } catch {
    return null;
  }
}

export function setAvatarTicket(ticket: string | null): void {
  try {
    if (ticket) sessionStorage.setItem(AVATAR_TICKET_STORAGE_KEY, ticket);
    else sessionStorage.removeItem(AVATAR_TICKET_STORAGE_KEY);
  } catch {
    // Storage blocked: the avatar simply does not follow to the next world.
  }
}

/** Adds the current ticket to a destination URL's fragment, unless it already has one. */
export function withAvatarTicket(url: URL): URL {
  const ticket = getAvatarTicket();
  if (ticket && !url.hash && /^https?:$/.test(url.protocol)) {
    url.hash = `${AVATAR_TICKET_PARAM}=${ticket}`;
  }
  return url;
}

/**
 * Exchanges a ticket at the hub for a descriptor. Sends no cookies and no
 * credentials. Null when the visitor has not chosen an avatar, the ticket has
 * expired, or the hub cannot be reached.
 */
export async function resolveWorldMeshAvatar(hubUrl: string, ticket: string, timeoutMs = 10_000): Promise<AvatarDescriptor | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/api/account/avatar/resolve', hubUrl), {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal: controller.signal,
    });
    if (response.status === 401) {
      setAvatarTicket(null);
      return null;
    }
    if (!response.ok) return null;
    const body = (await response.json()) as { avatar?: unknown };
    return parseAvatarDescriptor(body.avatar);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The relay refuses a full room with HTTP 503 and the body "Room is full"
 * before the WebSocket upgrade. Browsers do not expose that status on a failed
 * handshake (close is usually 1006 with an empty reason). Node's `ws` package
 * can surface it via `unexpected-response`. These helpers classify both.
 */

/** Close / HTTP / error shapes that mean the relay refused a full room. */
export function isRoomFullSignal(signal: {
  status?: number;
  code?: number;
  reason?: string;
  message?: string;
  body?: string;
} | null | undefined): boolean {
  if (!signal) return false;
  if (signal.status === 503) return true;
  const text = [signal.reason, signal.message, signal.body].filter((part) => typeof part === 'string').join(' ');
  return /room is full/i.test(text);
}

/** Copy on the full-screen overlay. Named rooms (the hub lobby) vs world rooms. */
export function roomFullLabel(wsUrl: string): string {
  try {
    if (/^\/room\//i.test(new URL(wsUrl).pathname)) return 'Lobby is full';
  } catch {
    // Fall through to the world wording.
  }
  return 'World is full';
}

export function presenceHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/i, 'http');
}

/** GET /occupancy query for this Presence URL (named room or this page's world). */
export function occupancyProbeUrl(wsUrl: string, pageOrigin?: string): string | null {
  try {
    const url = new URL(presenceHttpUrl(wsUrl));
    const room = url.pathname.match(/^\/room\/([a-z0-9-]{1,64})$/i);
    if (room) {
      url.pathname = '/occupancy';
      url.search = `rooms=${encodeURIComponent(room[1].toLowerCase())}`;
      return url.toString();
    }
    if (/\/world\/?$/i.test(url.pathname)) {
      const origin = pageOrigin || (typeof location !== 'undefined' ? location.origin : '');
      if (!origin) return null;
      url.pathname = '/occupancy';
      url.search = `origins=${encodeURIComponent(origin)}`;
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export function occupancyIsFull(payload: unknown, wsUrl: string, pageOrigin?: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload as Record<string, unknown>;
  let key: string | null = null;
  try {
    const path = new URL(wsUrl).pathname;
    const room = path.match(/^\/room\/([a-z0-9-]{1,64})$/i);
    if (room) key = `room:${room[1].toLowerCase()}`;
    else {
      const origin = (pageOrigin || (typeof location !== 'undefined' ? location.origin : '')).toLowerCase();
      key = origin || null;
    }
  } catch {
    return false;
  }
  if (!key) return false;
  const entry = data[key];
  if (!entry || typeof entry !== 'object') return false;
  const { count, cap } = entry as { count?: unknown; cap?: unknown };
  return atCapacity(count, cap);
}

function atCapacity(count: unknown, cap: unknown): boolean {
  return (
    typeof count === 'number' &&
    typeof cap === 'number' &&
    Number.isFinite(count) &&
    Number.isFinite(cap) &&
    cap > 0 &&
    count >= cap
  );
}

export type ProbeFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

/**
 * The shared relay turns a world away for the rest of the UTC day once its
 * room has used the free daily allowance: HTTP 429 with "allowance" in the
 * body. A plain 429 ("Too many requests") is only a short rate limit.
 */
export function isOverAllowanceSignal(signal: { status?: number; body?: string } | null | undefined): boolean {
  return signal?.status === 429 && /allowance/i.test(signal.body ?? '');
}

/** Why a join was refused: the room is full, the world is past today's allowance, or neither (a network blip). */
export type RoomProbe = 'full' | 'allowance' | 'open';

/**
 * After a handshake that never welcomed us, ask the relay why. Same-path GET
 * (no Upgrade) is the browser stand-in for the refused upgrade; GET
 * /occupancy covers older relays and Node callers that omit Origin.
 */
export async function probeRoom(
  wsUrl: string,
  pageOrigin?: string,
  fetchFn: ProbeFetch = fetch as ProbeFetch,
): Promise<RoomProbe> {
  const origin = pageOrigin || (typeof location !== 'undefined' ? location.origin : undefined);
  const headers: Record<string, string> = { Accept: 'text/plain, application/json' };
  if (origin) headers.Origin = origin;

  try {
    const direct = await fetchFn(presenceHttpUrl(wsUrl), { method: 'GET', headers });
    const text = await direct.text();
    if (isRoomFullSignal({ status: direct.status, body: text })) return 'full';
    if (isOverAllowanceSignal({ status: direct.status, body: text })) return 'allowance';
    if (direct.ok) {
      try {
        const json = JSON.parse(text) as { count?: unknown; cap?: unknown };
        if (atCapacity(json.count, json.cap)) return 'full';
      } catch {
        // Not occupancy JSON (e.g. the old 426 body).
      }
    }
  } catch {
    // Fall through to /occupancy.
  }

  const occupancyUrl = occupancyProbeUrl(wsUrl, origin);
  if (!occupancyUrl) return 'open';
  try {
    const res = await fetchFn(occupancyUrl, { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (isRoomFullSignal({ status: res.status, body: text })) return 'full';
    if (!res.ok) return 'open';
    return occupancyIsFull(JSON.parse(text), wsUrl, origin) ? 'full' : 'open';
  } catch {
    return 'open';
  }
}

/** probeRoom, answering only whether the room is full. */
export async function probeRoomFull(
  wsUrl: string,
  pageOrigin?: string,
  fetchFn: ProbeFetch = fetch as ProbeFetch,
): Promise<boolean> {
  return (await probeRoom(wsUrl, pageOrigin, fetchFn)) === 'full';
}

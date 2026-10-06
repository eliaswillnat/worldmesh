import { DurableObject } from 'cloudflare:workers';
import { chatRejection } from './chatFilter';

/**
 * Presence relay: who is standing where (and what face they are pulling), nothing else.
 *
 * Each room is one Durable Object holding hibernatable WebSockets. Rooms are
 * either named (`/room/lobby`, used by the hub) or belong to a world
 * (`/world`): the room is picked from the page's Origin header, so a world
 * gets its own room without registering, and one site cannot open another
 * site's room from a browser.
 *
 * A peer
 * sends its position a few times a second; the room forwards it to everyone
 * else. No accounts, no storage, no game logic — the smallest thing that lets
 * visitors of the same space see each other.
 *
 * Protocol (JSON text frames):
 *   server → client  { t: 'welcome', id, peers: [{ id, p, r, e, n, a, g, k }] }
 *   client → server  { t: 's', p: [x, y, z], r: yaw, e?: expression, n?: username, a?: alias, g?: grounded, k?: '#rrggbb' }
 *   server → client  { t: 's', id, p, r, e, n, a, g?, k }   another peer moved ('' n and a = guest; g 1 on the ground, 0 in the air; '' k = default colour)
 *   client → server  { t: 'c', m }             a short line of chat
 *   server → client  { t: 'c', id, m }         that line, for everyone else
 *   server → client  { t: 'leave', id }        another peer left
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Optional: set both (wrangler secret put) to get a Telegram message when someone enters. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

interface Peer {
  id: string;
  p: [number, number, number];
  r: number;
  /** Avatar expression name, e.g. 'smile'. Clients ignore names they do not know. */
  e: string;
  /** Username shown above the avatar; '' for guests. Self-reported by the client, not verified. */
  n: string;
  /**
   * Made-up display name for a signed-in visitor in private mode, e.g.
   * 'Quiet Fox'. Never an account name: clients draw it without an '@'.
   */
  a: string;
  /** 1 standing on something, 0 in the air; absent from clients too old to say. */
  g?: 0 | 1;
  /** Body colour, '#rrggbb', or '' for the default. */
  k: string;
  /** False until the peer has sent its first position. */
  seen: boolean;
  /** Last time this peer sent a chat line, so they cannot flood the room. */
  chatAt: number;
  /** Ping the owner on Telegram when this peer appears. Only for named rooms. */
  notify: boolean;
}

/** Named rooms such as the hub lobby. */
const MAX_ROOM_PEERS = 64;
/** A world's room. Lower, because every creator's world draws on the same free plan. */
const MAX_WORLD_PEERS = 16;
/** Set by this Worker on the request it hands to a room; clients cannot choose it. */
const ROOM_HEADER = 'X-WorldMesh-Room';
const MAX_MESSAGE_BYTES = 256;
/** Anything further than this from the origin is nonsense, not a position. */
const MAX_COORD = 10_000;
const EXPRESSION = /^[a-z]{1,16}$/;
/** Same shape as workers/auth USERNAME_PATTERN. */
const USERNAME = /^[a-z][a-z0-9_]{2,29}$/;
/** Two capitalised words; cannot be mistaken for a username, which is lower case. */
const ALIAS = /^[A-Z][a-z]{1,11} [A-Z][a-z]{1,11}$/;
const COLOR = /^#[0-9a-f]{6}$/;
/** Public occupancy reads are counts only; never peer names. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
/** How many world origins one occupancy request may ask about. */
const MAX_OCCUPANCY_ORIGINS = 50;
/** Named rooms (e.g. lobby) on the same public occupancy read. */
const MAX_OCCUPANCY_ROOMS = 20;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Public read: how full each world's presence room is (count + cap, no names).
    // The hub polls this to blur door covers before someone walks into a full world.
    if (request.method === 'GET' && url.pathname === '/occupancy') {
      return occupancy(url, env);
    }

    let name: string;
    let kind: 'room' | 'world';
    const match = url.pathname.match(/^\/room\/([a-z0-9-]{1,64})$/i);
    if (match) {
      name = match[1].toLowerCase();
      kind = 'room';
    } else if (url.pathname === '/world') {
      const origin = worldOrigin(request.headers.get('Origin'));
      if (!origin) return new Response('A world room needs an http(s) Origin', { status: 403 });
      // Prefixed so a world can never land in a named room such as the lobby.
      name = `world:${origin}`;
      kind = 'world';
    } else {
      return new Response('WorldMesh presence', { status: 404 });
    }

    const room = env.ROOMS.get(env.ROOMS.idFromName(name));

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      // Browsers never see the 503 on a failed upgrade. A plain GET to the
      // same path is the public stand-in: 503 + "Room is full", or count/cap.
      if (request.method === 'GET') {
        return room.occupancyHttp(kind === 'world');
      }
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const forwarded = new Request(request);
    forwarded.headers.set(ROOM_HEADER, kind);
    return room.fetch(forwarded);
  },
};

/**
 * GET /occupancy?origins=https://a.example,https://b.example&rooms=lobby
 * → { "https://a.example": { count, cap }, "room:lobby": { count, cap }, ... }
 *
 * Cap is the live room limit. Counts are open sockets; peer names stay private.
 */
async function occupancy(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get('origins') ?? url.searchParams.get('origin') ?? '';
  const origins = [
    ...new Set(
      raw
        .split(',')
        .map((value) => worldOrigin(value.trim()))
        .filter((origin): origin is string => !!origin),
    ),
  ].slice(0, MAX_OCCUPANCY_ORIGINS);

  const named = [
    ...new Set(
      (url.searchParams.get('rooms') ?? url.searchParams.get('room') ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((name) => /^[a-z0-9-]{1,64}$/.test(name)),
    ),
  ].slice(0, MAX_OCCUPANCY_ROOMS);

  const rooms: Record<string, { count: number; cap: number }> = {};
  await Promise.all([
    ...origins.map(async (origin) => {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(`world:${origin}`));
      const { count } = await stub.occupancy();
      rooms[origin] = { count, cap: MAX_WORLD_PEERS };
    }),
    ...named.map(async (name) => {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
      const { count } = await stub.occupancy();
      rooms[`room:${name}`] = { count, cap: MAX_ROOM_PEERS };
    }),
  ]);
  return new Response(JSON.stringify(rooms), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** 'https://forest.example' (scheme + host + port), or null for opaque/odd origins. */
function worldOrigin(header: string | null): string | null {
  if (!header) return null;
  try {
    const url = new URL(header);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const isWorld = request.headers.get(ROOM_HEADER) === 'world';
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= (isWorld ? MAX_WORLD_PEERS : MAX_ROOM_PEERS)) {
      return new Response('Room is full', { status: 503, headers: CORS });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), p: [0, 0, 0], r: 0, e: 'smile', n: '', a: '', k: '', seen: false, chatAt: 0, notify: !isWorld };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const peers = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((other): other is Peer => !!other?.seen)
      .map(({ id, p, r, e, n, a, g, k }) => ({ id, p, r, e, n: n ?? '', a: a ?? '', g, k: k ?? '' }));
    server.send(JSON.stringify({ t: 'welcome', id: peer.id, peers }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;

    let data: { t?: unknown; p?: unknown; r?: unknown; e?: unknown; n?: unknown; a?: unknown; g?: unknown; k?: unknown; m?: unknown };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.t === 'c') {
      this.relayChat(ws, data.m);
      return;
    }
    if (data?.t !== 's') return;

    const position = data.p;
    const yaw = data.r;
    if (
      !Array.isArray(position) ||
      position.length !== 3 ||
      !position.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_COORD) ||
      typeof yaw !== 'number' ||
      !Number.isFinite(yaw)
    ) {
      return;
    }

    const peer = ws.deserializeAttachment() as Peer;
    if (!peer.seen && peer.notify) this.ctx.waitUntil(this.notifyEntered());
    peer.p = position.map(round) as Peer['p'];
    peer.r = round(yaw);
    if (typeof data.e === 'string' && EXPRESSION.test(data.e)) peer.e = data.e;
    if (typeof data.n === 'string') peer.n = USERNAME.test(data.n) ? data.n : '';
    peer.a = typeof data.a === 'string' && ALIAS.test(data.a) ? data.a : '';
    peer.g = data.g === 0 || data.g === 1 ? data.g : undefined;
    peer.k = typeof data.k === 'string' && COLOR.test(data.k.toLowerCase()) ? data.k.toLowerCase() : '';
    peer.seen = true;
    ws.serializeAttachment(peer);

    this.broadcast(JSON.stringify({ t: 's', id: peer.id, p: peer.p, r: peer.r, e: peer.e, n: peer.n ?? '', a: peer.a ?? '', g: peer.g, k: peer.k ?? '' }), ws);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.leave(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  /**
   * Who is here right now, for the admin dashboard (workers/admin binds this
   * namespace and calls it over RPC; nothing public can reach it). The same
   * fields every peer in the room already receives, nothing more.
   */
  async stats(): Promise<{ connections: number; peers: { id: string; name: string; alias: string; position: [number, number, number] }[] }> {
    const sockets = this.ctx.getWebSockets();
    const peers = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((peer): peer is Peer => !!peer?.seen)
      .map((peer) => ({ id: peer.id, name: peer.n ?? '', alias: peer.a ?? '', position: peer.p }));
    return { connections: sockets.length, peers };
  }

  /**
   * Open socket count only. Served publicly via GET /occupancy so the hub can
   * mark full world doors without reading peer names or positions.
   */
  async occupancy(): Promise<{ count: number }> {
    return { count: this.ctx.getWebSockets().length };
  }

  /** Plain GET to /room/… or /world — browsers use this after a silent failed upgrade. */
  async occupancyHttp(isWorld: boolean): Promise<Response> {
    const cap = isWorld ? MAX_WORLD_PEERS : MAX_ROOM_PEERS;
    const count = this.ctx.getWebSockets().length;
    const full = count >= cap;
    return new Response(full ? 'Room is full' : JSON.stringify({ count, cap }), {
      status: full ? 503 : 200,
      headers: {
        'Content-Type': full ? 'text/plain; charset=utf-8' : 'application/json',
        ...CORS,
      },
    });
  }

  /** Tell the owner on Telegram that someone started walking in this room. */
  private async notifyEntered(): Promise<void> {
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = this.env;
    if (!token || !chatId) return;
    const count = this.ctx.getWebSockets().length;
    const text = `🌍 Someone entered the WorldMesh lobby (${count} online)`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      // Notifications are best-effort.
    }
  }

  /** One short line, forwarded unless it has blocked words or links. Nothing is stored. */
  private relayChat(ws: WebSocket, raw: unknown): void {
    if (typeof raw !== 'string') return;
    const text = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!text || chatRejection(text)) return;
    const peer = ws.deserializeAttachment() as Peer | null;
    if (!peer?.seen) return;
    const now = Date.now();
    if (now - peer.chatAt < 400) return;
    peer.chatAt = now;
    ws.serializeAttachment(peer);
    this.broadcast(JSON.stringify({ t: 'c', id: peer.id, m: text }), ws);
  }

  private leave(ws: WebSocket): void {
    const peer = ws.deserializeAttachment() as Peer | null;
    if (peer?.seen) this.broadcast(JSON.stringify({ t: 'leave', id: peer.id }), ws);
  }

  private broadcast(message: string, except: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(message);
      } catch {
        // The socket is closing; its own close handler cleans up.
      }
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

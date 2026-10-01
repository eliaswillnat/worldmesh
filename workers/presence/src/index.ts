import { DurableObject } from 'cloudflare:workers';

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
 *   server → client  { t: 'welcome', id, peers: [{ id, p, r, e, n, a }] }
 *   client → server  { t: 's', p: [x, y, z], r: yaw, e?: expression, n?: username, a?: alias }
 *   server → client  { t: 's', id, p, r, e, n, a }   another peer moved ('' n and a = guest)
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const forwarded = new Request(request);
    forwarded.headers.set(ROOM_HEADER, kind);
    const room = env.ROOMS.get(env.ROOMS.idFromName(name));
    return room.fetch(forwarded);
  },
};

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
    if (sockets.length >= (isWorld ? MAX_WORLD_PEERS : MAX_ROOM_PEERS)) return new Response('Room is full', { status: 503 });

    const { 0: client, 1: server } = new WebSocketPair();
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), p: [0, 0, 0], r: 0, e: 'smile', n: '', a: '', seen: false, chatAt: 0, notify: !isWorld };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const peers = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((other): other is Peer => !!other?.seen)
      .map(({ id, p, r, e, n, a }) => ({ id, p, r, e, n: n ?? '', a: a ?? '' }));
    server.send(JSON.stringify({ t: 'welcome', id: peer.id, peers }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;

    let data: { t?: unknown; p?: unknown; r?: unknown; e?: unknown; n?: unknown; a?: unknown; m?: unknown };
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
    peer.seen = true;
    ws.serializeAttachment(peer);

    this.broadcast(JSON.stringify({ t: 's', id: peer.id, p: peer.p, r: peer.r, e: peer.e, n: peer.n ?? '', a: peer.a ?? '' }), ws);
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

  /** One short line, forwarded as-is. Nothing is stored. */
  private relayChat(ws: WebSocket, raw: unknown): void {
    if (typeof raw !== 'string') return;
    const text = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (!text) return;
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

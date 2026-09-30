import { DurableObject } from 'cloudflare:workers';

/**
 * Presence relay: who is standing where (and what face they are pulling), nothing else.
 *
 * Each room is one Durable Object holding hibernatable WebSockets. A peer
 * sends its position a few times a second; the room forwards it to everyone
 * else. No accounts, no storage, no game logic — the smallest thing that lets
 * visitors of the same space see each other.
 *
 * Protocol (JSON text frames):
 *   server → client  { t: 'welcome', id, peers: [{ id, p, r, e, n }] }
 *   client → server  { t: 's', p: [x, y, z], r: yaw, e?: expression, n?: username }
 *   server → client  { t: 's', id, p, r, e, n }   another peer moved ('' n = guest)
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
  /** False until the peer has sent its first position. */
  seen: boolean;
}

const MAX_PEERS = 64;
const MAX_MESSAGE_BYTES = 256;
/** Anything further than this from the origin is nonsense, not a position. */
const MAX_COORD = 10_000;
const EXPRESSION = /^[a-z]{1,16}$/;
/** Same shape as workers/auth USERNAME_PATTERN. */
const USERNAME = /^[a-z][a-z0-9_]{2,29}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([a-z0-9-]{1,64})$/i);
    if (!match) return new Response('WorldMesh presence', { status: 404 });

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1].toLowerCase()));
    return room.fetch(request);
  },
};

export class Room extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PEERS) return new Response('Room is full', { status: 503 });

    const { 0: client, 1: server } = new WebSocketPair();
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), p: [0, 0, 0], r: 0, e: 'smile', n: '', seen: false };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const peers = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((other): other is Peer => !!other?.seen)
      .map(({ id, p, r, e, n }) => ({ id, p, r, e, n: n ?? '' }));
    server.send(JSON.stringify({ t: 'welcome', id: peer.id, peers }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;

    let data: { t?: unknown; p?: unknown; r?: unknown; e?: unknown; n?: unknown };
    try {
      data = JSON.parse(message);
    } catch {
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
    if (!peer.seen) this.ctx.waitUntil(this.notifyEntered());
    peer.p = position.map(round) as Peer['p'];
    peer.r = round(yaw);
    if (typeof data.e === 'string' && EXPRESSION.test(data.e)) peer.e = data.e;
    if (typeof data.n === 'string') peer.n = USERNAME.test(data.n) ? data.n : '';
    peer.seen = true;
    ws.serializeAttachment(peer);

    this.broadcast(JSON.stringify({ t: 's', id: peer.id, p: peer.p, r: peer.r, e: peer.e, n: peer.n ?? '' }), ws);
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

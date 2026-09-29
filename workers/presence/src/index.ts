import { DurableObject } from 'cloudflare:workers';

/**
 * Presence relay: who is standing where, nothing else.
 *
 * Each room is one Durable Object holding hibernatable WebSockets. A peer
 * sends its position a few times a second; the room forwards it to everyone
 * else. No accounts, no storage, no game logic — the smallest thing that lets
 * visitors of the same space see each other.
 *
 * Protocol (JSON text frames):
 *   server → client  { t: 'welcome', id, peers: [{ id, p, r }] }
 *   client → server  { t: 's', p: [x, y, z], r: yaw }
 *   server → client  { t: 's', id, p, r }      another peer moved
 *   server → client  { t: 'leave', id }        another peer left
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

interface Peer {
  id: string;
  p: [number, number, number];
  r: number;
  /** False until the peer has sent its first position. */
  seen: boolean;
}

const MAX_PEERS = 64;
const MAX_MESSAGE_BYTES = 256;
/** Anything further than this from the origin is nonsense, not a position. */
const MAX_COORD = 10_000;

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
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), p: [0, 0, 0], r: 0, seen: false };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const peers = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((other): other is Peer => !!other?.seen)
      .map(({ id, p, r }) => ({ id, p, r }));
    server.send(JSON.stringify({ t: 'welcome', id: peer.id, peers }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;

    let data: { t?: unknown; p?: unknown; r?: unknown };
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
    peer.p = position.map(round) as Peer['p'];
    peer.r = round(yaw);
    peer.seen = true;
    ws.serializeAttachment(peer);

    this.broadcast(JSON.stringify({ t: 's', id: peer.id, p: peer.p, r: peer.r }), ws);
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

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
 *   client → server  { t: 'o', k, v }          shared state of something in the room (a lift, a door)
 *   server → client  { t: 'o', id, k, v }      that state, for everyone including the sender, in the order the room took it
 *   server → client  welcome also carries `objects: [{ k, v, ms }]`, the last state of each key and its age
 *   client → server  { t: 'v', u, f, i, x, s } this peer's avatar: model URL (https), format, short stable id, expiry, hub signature; no u = default body
 *   server → client  { t: 'v', id, u?, f?, i?, x?, s? } another peer's avatar changed (sent only once they are seen)
 *   server → client  welcome peers also carry `v: { u, f, i, x, s }` when they wear one, so late joiners see it too
 *   The relay does not check the signature: every client checks it against the hub's key before downloading anything.
 *
 *   client → server  'ping'                    keep-alive while standing still; the room answers 'pong' without waking up
 *
 * Push-to-talk voice (only with VOICE = "on"; the welcome then carries `voice: 1`), binary frames:
 *   client → server  [1, ...samples]                      80 ms of 16 kHz μ-law while the talk button is held
 *   server → client  [1, ...id (8 ASCII bytes), ...samples]   the same, from a peer within VOICE_RANGE metres
 *   Nothing is stored or listened to; frames go only to people standing near enough to hear them.
 *   The runtime's side is packages/runtime/src/net/voiceCodec.ts.
 *
 * Shared state is the one thing the room remembers: the latest value per key,
 * so someone walking in sees the lift where everyone else does. Sending it
 * back to the sender too gives every client the same order of writes, so two
 * people pressing at once still end up agreeing.
 *
 * This directory (templates/relay) is also the one-click template anyone can
 * deploy as their own relay (README.md). WorldMesh runs the same code as two
 * Workers: workers/lobby (the hub's own lobby, named rooms only) and
 * workers/presence (relay.worldmesh.net, the free relay for independent
 * worlds, world rooms only). The vars below say which, and set the room caps.
 * On the free relay each world has a daily allowance of active minutes; past
 * it, new visitors get 429 and stay single-player until the next UTC day.
 * A relay can also serve only the worlds in ALLOWED_ORIGINS; others get 403.
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Optional: set both (wrangler secret put) to get a Telegram message when someone enters. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Named rooms this relay serves, comma-separated, e.g. "lobby". Unset or empty: none. */
  NAMED_ROOMS?: string;
  /** "off": this relay serves no world rooms (`/world`). */
  WORLD_ROOMS?: string;
  /** Minutes a world's room may be active each UTC day. Unset or 0: no limit. */
  WORLD_DAILY_MINUTES?: string;
  /** The relay owner's own worlds, exempt from the daily limit: origins, or "*.example.net" for subdomains. */
  OWN_ORIGINS?: string;
  /** The only worlds this relay serves, written like OWN_ORIGINS. Unset or empty: every world. */
  ALLOWED_ORIGINS?: string;
  /** Secret (wrangler secret put BLOCKED_ORIGINS): origins refused outright, comma-separated. */
  BLOCKED_ORIGINS?: string;
  /** People at once in one world's room. Unset or not a positive whole number: 16. */
  MAX_WORLD_PEERS?: string;
  /** People at once in one named room, such as the hub lobby. Unset or not a positive whole number: 64. */
  MAX_ROOM_PEERS?: string;
  /** "on": hand push-to-talk voice on to people nearby. Anything else: voice frames are dropped. */
  VOICE?: string;
  /** Per-IP limits on WebSocket joins and on plain reads (occupancy, full probes). */
  JOIN_LIMIT?: RateLimit;
  READ_LIMIT?: RateLimit;
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
  /** Last time this peer changed shared state. */
  sharedAt?: number;
  /** Last time this peer changed its avatar. */
  avatarAt?: number;
  /** Wears an avatar, kept in storage under `v:<id>` (too long for the socket attachment). */
  avatar?: boolean;
}

/** A peer's avatar as the room remembers it. */
interface PeerAvatar {
  u: string;
  f: string;
  i: string;
  /** Unix seconds the signature lasts until. */
  x: number;
  /** The hub's Ed25519 signature, base64url. */
  s: string;
}

/** How long a room was active on one UTC day ('2026-10-15'), for the daily allowance. */
interface Activity {
  day: string;
  ms: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The latest value of one key of shared state, and when it was set. */
interface Shared {
  v: Record<string, unknown>;
  at: number;
}

/** Named rooms such as the hub lobby, unless MAX_ROOM_PEERS says otherwise. */
const DEFAULT_ROOM_PEERS = 64;
/** A world's room, unless MAX_WORLD_PEERS says otherwise. Lower, because every creator's world draws on the same free plan. */
const DEFAULT_WORLD_PEERS = 16;
/** Set by this Worker on the request it hands to a room; clients cannot choose it. */
const ROOM_HEADER = 'X-WorldMesh-Room';
const MAX_MESSAGE_BYTES = 256;
/** Avatar messages carry a model URL, often a long presigned one. */
const MAX_AVATAR_MESSAGE_BYTES = 2048;
const MAX_AVATAR_URL = 1800;
const AVATAR_FORMAT = /^(vrm|glb|gltf)$/;
const AVATAR_ID = /^[a-z0-9]{1,16}$/;
const AVATAR_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** Shortest gap between two avatar changes from one peer. */
const AVATAR_MIN_MS = 1000;
/** Anything further than this from the origin is nonsense, not a position. */
const MAX_COORD = 10_000;
const EXPRESSION = /^[a-z]{1,16}$/;
/** Same shape as workers/auth USERNAME_PATTERN. */
const USERNAME = /^[a-z][a-z0-9_]{2,29}$/;
/** Two capitalised words; cannot be mistaken for a username, which is lower case. */
const ALIAS = /^[A-Z][a-z]{1,11} [A-Z][a-z]{1,11}$/;
const COLOR = /^#[0-9a-f]{6}$/;
/** Keys of shared state, e.g. 'lift:0'. */
const SHARED_KEY = /^[a-z0-9:_-]{1,32}$/;
/** How many keys one room remembers. New keys past this are dropped. */
const MAX_SHARED_KEYS = 32;
/** Shortest gap between two shared-state writes from one peer. */
const SHARED_MIN_MS = 80;
/** First byte of a voice frame, and the sender id put after it (packages/runtime/src/net/voiceCodec.ts). */
const VOICE_KIND = 1;
const VOICE_ID_BYTES = 8;
/** A frame is 1281 bytes; anything much bigger is not one. */
const MAX_VOICE_BYTES = 2048;
/** Voice goes to people this many metres from the speaker at most. Clients fade it out a little closer (40 m). */
const VOICE_RANGE = 45;
/** One talker is 16 KB a second. A little over that is allowed, and a burst of about a second and a half, for a slow phone that sends its frames in clumps. */
const VOICE_BYTES_PER_S = 20_000;
const VOICE_BURST_BYTES = 24_000;
/** Public occupancy reads are counts only; never peer names. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
/** How many world origins one occupancy request may ask about. Each one is a call to that world's room. */
const MAX_OCCUPANCY_ORIGINS = 24;
/** Named rooms (e.g. lobby) on the same public occupancy read. */
const MAX_OCCUPANCY_ROOMS = 4;
/** Occupancy answers are shared at the edge this long, so a hall full of visitors asks each room once. */
const OCCUPANCY_CACHE_S = 10;
/** Tells the room this world's daily allowance in minutes (0: none). Set by this Worker only. */
const ALLOWANCE_HEADER = 'X-WorldMesh-Allowance';
/** Once a world is past its allowance, the edge answers for it this long without waking its room. */
const OVER_ALLOWANCE_CACHE_S = 600;
/** Gaps between messages longer than this are not counted: the room was quiet and could sleep. */
const ACTIVE_GAP_MS = 15_000;
/** How often a busy room writes its active time to storage. */
const ACTIVITY_FLUSH_MS = 60_000;
/** Body of the 429 for a world past its allowance. Clients match "allowance". Any relay, WorldMesh's or someone else's. */
const OVER_ALLOWANCE = "This world has used today's free multiplayer allowance on this relay. Visitors stay single-player until 00:00 UTC. Run your own relay to lift the limit (https://worldmesh.net/connect.md), or, if this relay is yours, list the world in OWN_ORIGINS.";
/** Body of the 403 for a world not in ALLOWED_ORIGINS. */
const NOT_ALLOWED = "This world is not in this relay's ALLOWED_ORIGINS. Run your own relay: https://worldmesh.net/connect.md";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Public read: how full each world's presence room is (count + cap, no names).
    // The hub polls this to blur door covers before someone walks into a full world.
    if (request.method === 'GET' && url.pathname === '/occupancy') {
      if (await limited(env.READ_LIMIT, request)) return tooMany();
      return occupancy(url, env, ctx);
    }

    let name: string;
    let kind: 'room' | 'world';
    let origin = '';
    const match = url.pathname.match(/^\/room\/([a-z0-9-]{1,64})$/i);
    if (match) {
      name = match[1].toLowerCase();
      // Only the rooms this relay is set up for: anyone could otherwise make new ones.
      if (!list(env.NAMED_ROOMS).includes(name)) return new Response('No such room', { status: 404, headers: CORS });
      kind = 'room';
    } else if (url.pathname === '/world') {
      if (env.WORLD_ROOMS === 'off') return new Response('This relay has no world rooms', { status: 404, headers: CORS });
      origin = worldOrigin(request.headers.get('Origin')) ?? '';
      if (!origin) return new Response('A world room needs an http(s) Origin', { status: 403 });
      if (list(env.BLOCKED_ORIGINS).map(worldOrigin).includes(origin)) {
        return new Response('This world is blocked from this relay', { status: 403, headers: CORS });
      }
      if (!servesWorld(origin, env)) return notAllowed();
      // Prefixed so a world can never land in a named room such as the lobby.
      name = `world:${origin}`;
      kind = 'world';
    } else {
      return new Response('WorldMesh presence', { status: 404 });
    }

    const room = env.ROOMS.get(env.ROOMS.idFromName(name));
    const allowance = kind === 'world' ? allowanceFor(origin, env) : 0;

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      // Browsers never see the 503 on a failed upgrade. A plain GET to the
      // same path is the public stand-in: 503 + "Room is full", 429 past the
      // allowance, or count/cap.
      if (request.method === 'GET') {
        if (await limited(env.READ_LIMIT, request)) return tooMany();
        if (allowance && (await knownOverAllowance(url, origin))) return overAllowance();
        return room.occupancyHttp(kind === 'world', allowance);
      }
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    if (await limited(env.JOIN_LIMIT, request)) return tooMany();
    if (allowance && (await knownOverAllowance(url, origin))) return overAllowance();

    const forwarded = new Request(request);
    forwarded.headers.set(ROOM_HEADER, kind);
    forwarded.headers.set(ALLOWANCE_HEADER, String(allowance));
    const response = await room.fetch(forwarded);
    if (response.status === 429 && allowance) ctx.waitUntil(rememberOverAllowance(url, origin));
    return response;
  },
};

/** Comma-separated config value as a list. */
function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
}

/** How many people one room of this kind takes at once on this relay. */
function capFor(isWorld: boolean, env: Env): number {
  const value = Number(isWorld ? env.MAX_WORLD_PEERS : env.MAX_ROOM_PEERS);
  return Number.isInteger(value) && value > 0 ? value : isWorld ? DEFAULT_WORLD_PEERS : DEFAULT_ROOM_PEERS;
}

/** True when this world origin is on a list of origins and "*.example.net" entries (every https subdomain). */
function listed(origin: string, entries: string[]): boolean {
  const host = new URL(origin).hostname;
  return entries.some((entry) =>
    entry.startsWith('*.') ? origin.startsWith('https://') && host.endsWith(entry.slice(1)) : worldOrigin(entry) === origin,
  );
}

/** This world's daily allowance in minutes on this relay; 0 for none (no limit set, or one of the owner's own). */
function allowanceFor(origin: string, env: Env): number {
  const minutes = Number(env.WORLD_DAILY_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return listed(origin, list(env.OWN_ORIGINS)) ? 0 : minutes;
}

/** False when ALLOWED_ORIGINS is set and this world is not on it. */
function servesWorld(origin: string, env: Env): boolean {
  const allowed = list(env.ALLOWED_ORIGINS);
  return allowed.length === 0 || listed(origin, allowed);
}

function notAllowed(): Response {
  return new Response(NOT_ALLOWED, { status: 403, headers: CORS });
}

/** True when this request should be turned away for its IP. No binding (e.g. a self-hosted copy without one): never. */
async function limited(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
    return !success;
  } catch {
    return false;
  }
}

function tooMany(): Response {
  return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60', ...CORS } });
}

function overAllowance(): Response {
  const now = Date.now();
  const untilMidnight = Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);
  return new Response(OVER_ALLOWANCE, {
    status: 429,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(untilMidnight), ...CORS },
  });
}

/** Edge cache key marking a world past its allowance. Same host as the request, so the zone's cache takes it. */
function overAllowanceKey(url: URL, origin: string): string {
  return new URL(`/__over-allowance?o=${encodeURIComponent(origin)}`, url).toString();
}

async function knownOverAllowance(url: URL, origin: string): Promise<boolean> {
  try {
    return !!(await caches.default.match(overAllowanceKey(url, origin)));
  } catch {
    return false;
  }
}

async function rememberOverAllowance(url: URL, origin: string): Promise<void> {
  try {
    await caches.default.put(
      overAllowanceKey(url, origin),
      new Response('1', { headers: { 'Cache-Control': `public, max-age=${OVER_ALLOWANCE_CACHE_S}` } }),
    );
  } catch {
    // Only saves a room wake-up; the room still says no on its own.
  }
}

/**
 * GET /occupancy?origins=https://a.example,https://b.example&rooms=lobby
 * → { "https://a.example": { count, cap }, "room:lobby": { count, cap }, ... }
 *
 * Cap is the live room limit. Counts are open sockets; peer names stay private.
 * Answers are cached at the edge for a few seconds: every visitor in the hall
 * asks about the same doors. Worlds outside ALLOWED_ORIGINS are left out, so a
 * hall's other doors still get answers; 403 when nothing asked is served here.
 */
async function occupancy(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = url.searchParams.get('origins') ?? url.searchParams.get('origin') ?? '';
  const asked =
    env.WORLD_ROOMS === 'off'
      ? []
      : [
          ...new Set(
            raw
              .split(',')
              .map((value) => worldOrigin(value.trim()))
              .filter((origin): origin is string => !!origin),
          ),
        ];
  const origins = asked
    .filter((origin) => servesWorld(origin, env))
    .sort()
    .slice(0, MAX_OCCUPANCY_ORIGINS);

  const allowed = list(env.NAMED_ROOMS);
  const named = [
    ...new Set(
      (url.searchParams.get('rooms') ?? url.searchParams.get('room') ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((name) => allowed.includes(name)),
    ),
  ]
    .sort()
    .slice(0, MAX_OCCUPANCY_ROOMS);
  if (asked.length && !origins.length && !named.length) return notAllowed();

  const key = new URL('/occupancy', url);
  key.search = new URLSearchParams({ origins: origins.join(','), rooms: named.join(',') }).toString();
  const cached = await caches.default.match(key.toString()).catch(() => undefined);
  if (cached) return cached;

  const rooms: Record<string, { count: number; cap: number }> = {};
  await Promise.all([
    ...origins.map(async (origin) => {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(`world:${origin}`));
      const { count } = await stub.occupancy();
      rooms[origin] = { count, cap: capFor(true, env) };
    }),
    ...named.map(async (name) => {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(name));
      const { count } = await stub.occupancy();
      rooms[`room:${name}`] = { count, cap: capFor(false, env) };
    }),
  ]);
  const response = new Response(JSON.stringify(rooms), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${OCCUPANCY_CACHE_S}`, ...CORS },
  });
  ctx.waitUntil(caches.default.put(key.toString(), response.clone()).catch(() => undefined));
  return response;
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
  /** Shared state by key, kept in storage too so it outlives the room going idle. */
  private shared = new Map<string, Shared>();
  /** Last message from anyone, and active time not yet written to storage (see countActivity). */
  private activeAt = 0;
  private pendingActiveMs = 0;
  private flushedAt = 0;
  /** Voice each socket may still send right now, in bytes, and when that was worked out. Forgotten when the room sleeps, which is fine. */
  private voiceBudget = new WeakMap<WebSocket, { bytes: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alives are answered by the runtime, so a room where nobody moves can sleep.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<Shared>({ prefix: 'o:', limit: MAX_SHARED_KEYS });
      for (const [key, value] of stored) this.shared.set(key.slice(2), value);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const isWorld = request.headers.get(ROOM_HEADER) === 'world';
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= capFor(isWorld, this.env)) {
      return new Response('Room is full', { status: 503, headers: CORS });
    }
    // People already here stay; only new joins are turned away.
    const allowance = Number(request.headers.get(ALLOWANCE_HEADER)) || 0;
    if (allowance > 0 && (await this.activeMsToday()) >= allowance * 60_000) return overAllowance();

    const { 0: client, 1: server } = new WebSocketPair();
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), p: [0, 0, 0], r: 0, e: 'smile', n: '', a: '', k: '', seen: false, chatAt: 0, notify: !isWorld };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const seen = sockets
      .map((ws) => ws.deserializeAttachment() as Peer | null)
      .filter((other): other is Peer => !!other?.seen);
    const avatars = await this.avatarsOf(seen);
    const peers = seen.map(({ id, p, r, e, n, a, g, k }) => {
      const v = avatars.get(id);
      return { id, p, r, e, n: n ?? '', a: a ?? '', g, k: k ?? '', ...(v ? { v } : {}) };
    });
    const now = Date.now();
    const objects = [...this.shared].map(([k, { v, at }]) => ({ k, v, ms: Math.max(0, now - at) }));
    const voice = this.env.VOICE === 'on' ? { voice: 1 } : {};
    server.send(JSON.stringify({ t: 'welcome', id: peer.id, peers, objects, ...voice }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      if (this.env.VOICE === 'on') await this.relayVoice(ws, message);
      return;
    }
    if (message.length > MAX_AVATAR_MESSAGE_BYTES) return;

    let data: { t?: unknown; p?: unknown; r?: unknown; e?: unknown; n?: unknown; a?: unknown; g?: unknown; k?: unknown; m?: unknown; u?: unknown; f?: unknown; i?: unknown; x?: unknown; s?: unknown };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.t === 'v') {
      await this.relayAvatar(ws, data);
      return;
    }
    // Only avatar messages may be long.
    if (message.length > MAX_MESSAGE_BYTES) return;
    if (data?.t === 'c') {
      this.relayChat(ws, data.m);
      return;
    }
    if (data?.t === 'o') {
      this.relayShared(ws, (data as { k?: unknown }).k, (data as { v?: unknown }).v);
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
    await this.countActivity();
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
  async occupancyHttp(isWorld: boolean, allowance = 0): Promise<Response> {
    const cap = capFor(isWorld, this.env);
    const count = this.ctx.getWebSockets().length;
    const full = count >= cap;
    if (!full && allowance > 0 && (await this.activeMsToday()) >= allowance * 60_000) return overAllowance();
    return new Response(full ? 'Room is full' : JSON.stringify({ count, cap }), {
      status: full ? 503 : 200,
      headers: {
        'Content-Type': full ? 'text/plain; charset=utf-8' : 'application/json',
        ...CORS,
      },
    });
  }

  /**
   * Count the time this room is busy, which is roughly the time it is awake
   * and costs anything: the gaps between position messages, from anyone,
   * up to ACTIVE_GAP_MS. A room where everyone stands still (keep-alives
   * only) or that sits empty counts nothing. Written to storage at most
   * once a minute; what a room forgets when it sleeps is under a minute.
   */
  private async countActivity(): Promise<void> {
    const now = Date.now();
    const gap = now - this.activeAt;
    this.activeAt = now;
    if (gap > 0 && gap < ACTIVE_GAP_MS) this.pendingActiveMs += gap;
    if (this.pendingActiveMs === 0 || now - this.flushedAt < ACTIVITY_FLUSH_MS) return;
    const pending = this.pendingActiveMs;
    this.pendingActiveMs = 0;
    this.flushedAt = now;
    const day = utcDay(now);
    const stored = await this.ctx.storage.get<Activity>('activity');
    await this.ctx.storage.put('activity', { day, ms: (stored?.day === day ? stored.ms : 0) + pending });
  }

  /** Active time today (UTC), including what is not written yet. */
  private async activeMsToday(): Promise<number> {
    const stored = await this.ctx.storage.get<Activity>('activity');
    return (stored?.day === utcDay(Date.now()) ? stored.ms : 0) + this.pendingActiveMs;
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

  /**
   * A frame of someone talking, handed on with their id to everyone standing
   * within VOICE_RANGE of them. Never stored, never looked into beyond its
   * first byte; at most one person's worth of voice a second per socket.
   */
  private async relayVoice(ws: WebSocket, message: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(message);
    if (bytes.length < 2 || bytes.length > MAX_VOICE_BYTES || bytes[0] !== VOICE_KIND) return;
    const peer = ws.deserializeAttachment() as Peer | null;
    if (!peer?.seen) return;

    const now = Date.now();
    const budget = this.voiceBudget.get(ws) ?? { bytes: VOICE_BURST_BYTES, at: now };
    budget.bytes = Math.min(VOICE_BURST_BYTES, budget.bytes + ((now - budget.at) / 1000) * VOICE_BYTES_PER_S);
    budget.at = now;
    this.voiceBudget.set(ws, budget);
    if (budget.bytes < bytes.length) return;
    budget.bytes -= bytes.length;
    await this.countActivity();

    const frame = new Uint8Array(1 + VOICE_ID_BYTES + bytes.length - 1);
    frame[0] = VOICE_KIND;
    frame.fill(0x20, 1, 1 + VOICE_ID_BYTES);
    frame.set(new TextEncoder().encode(peer.id).subarray(0, VOICE_ID_BYTES), 1);
    frame.set(bytes.subarray(1), 1 + VOICE_ID_BYTES);
    const [x, y, z] = peer.p;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      const other = socket.deserializeAttachment() as Peer | null;
      if (!other?.seen) continue;
      const [ox, oy, oz] = other.p;
      if (Math.hypot(ox - x, oy - y, oz - z) > VOICE_RANGE) continue;
      try {
        socket.send(frame);
      } catch {
        // The socket is closing; its own close handler cleans up.
      }
    }
  }

  /**
   * Remember one key of shared state and pass it to everyone, the sender
   * included. Values are small flat objects of numbers; anything else is
   * dropped, so nothing a client sends can be text shown to others.
   */
  private relayShared(ws: WebSocket, key: unknown, value: unknown): void {
    if (typeof key !== 'string' || !SHARED_KEY.test(key)) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 8 || !entries.every(([name, v]) => /^[a-z]{1,8}$/.test(name) && typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_COORD)) return;
    if (!this.shared.has(key) && this.shared.size >= MAX_SHARED_KEYS) return;
    const peer = ws.deserializeAttachment() as Peer | null;
    if (!peer?.seen) return;
    const now = Date.now();
    if (now - (peer.sharedAt ?? 0) < SHARED_MIN_MS) return;
    peer.sharedAt = now;
    ws.serializeAttachment(peer);
    const v = Object.fromEntries(entries.map(([name, n]) => [name, round(n as number)]));
    const entry = { v, at: now };
    this.shared.set(key, entry);
    this.ctx.waitUntil(this.ctx.storage.put(`o:${key}`, entry));
    const message = JSON.stringify({ t: 'o', id: peer.id, k: key, v });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // The socket is closing; its own close handler cleans up.
      }
    }
  }

  /**
   * Remember which avatar a peer wears and tell everyone else. Only a signed
   * model link: the room never fetches or stores the model. An empty URL goes
   * back to the default body.
   */
  private async relayAvatar(ws: WebSocket, data: { u?: unknown; f?: unknown; i?: unknown; x?: unknown; s?: unknown }): Promise<void> {
    const { u: url, f: format, i: id, x: expires, s: signature } = data;
    const peer = ws.deserializeAttachment() as Peer | null;
    if (!peer?.seen) return;
    const now = Date.now();
    if (now - (peer.avatarAt ?? 0) < AVATAR_MIN_MS) return;

    let avatar: PeerAvatar | null = null;
    if (typeof url === 'string' && url) {
      if (url.length > MAX_AVATAR_URL || !isHttpsUrl(url)) return;
      if (typeof format !== 'string' || !AVATAR_FORMAT.test(format)) return;
      if (typeof id !== 'string' || !AVATAR_ID.test(id)) return;
      if (typeof expires !== 'number' || !Number.isInteger(expires) || expires <= 0 || expires > 1e11) return;
      if (typeof signature !== 'string' || !AVATAR_SIGNATURE.test(signature)) return;
      avatar = { u: url, f: format, i: id, x: expires, s: signature };
    }
    if (!avatar && !peer.avatar) return;

    peer.avatarAt = now;
    peer.avatar = !!avatar;
    ws.serializeAttachment(peer);
    if (avatar) await this.ctx.storage.put(`v:${peer.id}`, avatar);
    else await this.ctx.storage.delete(`v:${peer.id}`);
    this.broadcast(JSON.stringify(avatar ? { t: 'v', id: peer.id, ...avatar } : { t: 'v', id: peer.id }), ws);
  }

  /** The avatars of these peers, and stored avatars of anyone no longer here are forgotten. */
  private async avatarsOf(peers: Peer[]): Promise<Map<string, PeerAvatar>> {
    const avatars = new Map<string, PeerAvatar>();
    const stored = await this.ctx.storage.list<PeerAvatar>({ prefix: 'v:', limit: 256 });
    if (stored.size === 0) return avatars;
    const live = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Peer | null)?.id));
    const wearing = new Set(peers.filter((peer) => peer.avatar).map((peer) => peer.id));
    const stale: string[] = [];
    for (const [key, value] of stored) {
      const id = key.slice(2);
      if (wearing.has(id)) avatars.set(id, value);
      else if (!live.has(id)) stale.push(key);
    }
    if (stale.length) this.ctx.waitUntil(this.ctx.storage.delete(stale));
    return avatars;
  }

  private leave(ws: WebSocket): void {
    const peer = ws.deserializeAttachment() as Peer | null;
    if (peer?.avatar) this.ctx.waitUntil(this.ctx.storage.delete(`v:${peer.id}`));
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

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The presence Worker's room class, as seen across the script boundary (RPC). */
export interface RoomStats {
  /** Open sockets, including peers that have not sent a position yet. */
  connections: number;
  /** Peers that are actually walking around. */
  peers: { id: string; name: string; alias: string; position: [number, number, number] }[];
}

export interface PresenceRoom {
  stats(): Promise<RoomStats>;
}

export interface Env {
  /** The shared WorldMesh database (users, sessions, worlds, federation, ads, avatars). */
  DB: D1Database;
  /** The hub's world directory (Pages KV binding WORLDS): approved:* and pending:*. */
  WORLDS?: KVNamespace;
  /** workers/views: count:<url>. */
  VIEWS?: KVNamespace;
  /** workers/presence's Durable Object namespace (script_name binding). */
  ROOMS?: DurableObjectNamespace;

  /** https://worldmesh.net — where the session cookie lives. */
  HUB_ORIGIN: string;
  /** https://admin.worldmesh.net — where the dashboard is served. */
  ADMIN_ORIGIN: string;
  /** Comma-separated verified account emails that may open the dashboard. */
  ADMIN_EMAILS: string;
  /** Random, at least 32 bytes. Signs the hand-off ticket and the dashboard cookie. */
  ADMIN_SECRET: string;

  /** Presence Worker's public base (https), for the health check. */
  PRESENCE_URL?: string;
  /** Screenshot Worker's public base, for the health check. */
  SCREENSHOT_URL?: string;
  /** Secret: workers/screenshot's SCREENSHOT_SECRET. Cover uploads are refused without it. */
  SCREENSHOT_SECRET?: string;

  /** Optional Cloudflare API access for traffic and Worker metrics. */
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CF_ACCOUNT_ID?: string;

  /** Tests only: a fixed clock and a fetch stand-in. */
  NOW?: () => number;
  FETCH?: typeof fetch;
}

export function now(env: Env): number {
  return env.NOW ? env.NOW() : Date.now();
}

export function http(env: Env): typeof fetch {
  return env.FETCH ?? ((input, init) => fetch(input, init));
}

export function hubOrigin(env: Env): string {
  return env.HUB_ORIGIN.replace(/\/+$/, '');
}

export function adminOrigin(env: Env): string {
  return env.ADMIN_ORIGIN.replace(/\/+$/, '');
}

export function adminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertConfigured(env: Env): void {
  if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 32) {
    throw new Error('workers/admin needs ADMIN_SECRET (at least 32 characters).');
  }
  if (adminEmails(env).size === 0) throw new Error('workers/admin needs ADMIN_EMAILS.');
}

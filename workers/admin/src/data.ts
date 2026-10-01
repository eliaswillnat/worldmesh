/**
 * Everything the dashboard reads. Each source is fetched independently and
 * may fail on its own (a missing binding, a token not handed over yet, a
 * Worker down): a page then shows that one panel's error and the rest.
 *
 * Read-only. Nothing in this file writes anywhere.
 */
import { hubOrigin, http, now, type Env, type PresenceRoom, type RoomStats } from './env';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const DAY = 86_400_000;

export function toMillis(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? toMillis(Number(value)) : Date.parse(value);
  return NaN;
}

async function all<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...binds).all<T>();
  return result.results ?? [];
}

async function count(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Days ending today (UTC), oldest first, each with how many timestamps fell on it. */
export function perDay(times: number[], days: number, at: number): { day: string; n: number }[] {
  const end = Math.floor(at / DAY);
  const buckets = new Map<number, number>();
  for (const time of times) {
    const day = Math.floor(time / DAY);
    if (day > end - days && day <= end) buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return Array.from({ length: days }, (_, i) => {
    const day = end - days + 1 + i;
    return { day: new Date(day * DAY).toISOString().slice(0, 10), n: buckets.get(day) ?? 0 };
  });
}

// ── Users ──────────────────────────────────────────────────────────────────

export interface UserSummary {
  total: number;
  verified: number;
  withUsername: number;
  new24h: number;
  new7d: number;
  new30d: number;
  activeSessions: number;
  activeUsers24h: number;
  providers: { provider: string; n: number }[];
  signups: { day: string; n: number }[];
}

export async function userSummary(env: Env): Promise<UserSummary> {
  const at = now(env);
  const [users, sessions, providers] = await Promise.all([
    all<{ createdAt: unknown; emailVerified: unknown; username: string | null }>(
      env,
      `select "createdAt", "emailVerified", username from "user" limit 100000`,
    ),
    all<{ userId: string; expiresAt: unknown; updatedAt: unknown }>(env, `select "userId", "expiresAt", "updatedAt" from "session" limit 100000`),
    all<{ provider: string; n: number }>(env, `select "providerId" as provider, count(*) as n from account group by "providerId" order by n desc`),
  ]);
  const created = users.map((user) => toMillis(user.createdAt)).filter(Number.isFinite);
  const since = (ms: number) => created.filter((time) => time > at - ms).length;
  const live = sessions.filter((session) => toMillis(session.expiresAt) > at);
  const recent = new Set(live.filter((session) => toMillis(session.updatedAt) > at - DAY).map((session) => session.userId));
  return {
    total: users.length,
    verified: users.filter((user) => user.emailVerified === 1 || user.emailVerified === true || user.emailVerified === '1').length,
    withUsername: users.filter((user) => !!user.username).length,
    new24h: since(DAY),
    new7d: since(7 * DAY),
    new30d: since(30 * DAY),
    activeSessions: live.length,
    activeUsers24h: recent.size,
    providers: providers.map((row) => ({ provider: row.provider, n: Number(row.n) })),
    signups: perDay(created, 30, at),
  };
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: unknown;
  image: string | null;
  username: string | null;
  createdAt: unknown;
  providers: string | null;
  lastSeen: unknown;
  sessions: number;
  avatars: number;
  followers: number;
}

export async function users(env: Env, query: string, limit = 200): Promise<UserRow[]> {
  const like = `%${query.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
  return all<UserRow>(
    env,
    `select u.id, u.name, u.email, u."emailVerified", u.image, u.username, u."createdAt",
       (select group_concat(distinct a."providerId") from account a where a."userId" = u.id) as providers,
       (select max(s."updatedAt") from "session" s where s."userId" = u.id) as "lastSeen",
       (select count(*) from "session" s where s."userId" = u.id) as sessions,
       (select count(*) from avatar v where v.user_id = u.id) as avatars,
       (select count(*) from ap_follower f join ap_actor x on x.id = f.actor_id where x.user_id = u.id) as followers
     from "user" u
     where ? = '' or u.email like ? escape '\\' or u.name like ? escape '\\' or u.username like ? escape '\\'
     order by u."createdAt" desc
     limit ?`,
    query,
    like,
    like,
    like,
    limit,
  );
}

// ── Worlds ─────────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  id: string;
  name?: string;
  url?: string;
  description?: string;
  cover?: string;
  creator?: string;
  portfolio?: string;
  email?: string;
  submittedAt?: string;
  approvedAt?: string;
  addedAt?: string;
  curatedBy?: string;
  approveToken?: string;
}

async function kvEntries(kv: KVNamespace, prefix: string, cap = 1000): Promise<DirectoryEntry[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await kv.list({ prefix, cursor, limit: 1000 });
    keys.push(...list.keys.map((key) => key.name));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor && keys.length < cap);
  const values = await Promise.all(keys.slice(0, cap).map((name) => kv.get(name)));
  const entries: DirectoryEntry[] = [];
  values.forEach((raw, i) => {
    if (!raw) return;
    try {
      entries.push({ id: keys[i].slice(prefix.length), ...(JSON.parse(raw) as object) } as DirectoryEntry);
    } catch {
      entries.push({ id: keys[i].slice(prefix.length), name: '(unreadable entry)' });
    }
  });
  return entries;
}

export interface Directory {
  approved: DirectoryEntry[];
  pending: DirectoryEntry[];
}

export async function directory(env: Env): Promise<Directory> {
  if (!env.WORLDS) throw new Error('No WORLDS binding: add the hub’s KV namespace id to workers/admin/wrangler.toml.');
  const [approved, pending] = await Promise.all([kvEntries(env.WORLDS, 'approved:'), kvEntries(env.WORLDS, 'pending:')]);
  const newest = (a: string | undefined, b: string | undefined) => (b ?? '').localeCompare(a ?? '');
  approved.sort((a, b) => newest(a.approvedAt ?? a.addedAt, b.approvedAt ?? b.addedAt));
  pending.sort((a, b) => newest(a.submittedAt, b.submittedAt));
  return { approved, pending };
}

/** How the hub's approve link for a pending world looks (it approves on GET). */
export function approveLink(env: Env, entry: DirectoryEntry): string | null {
  if (!entry.approveToken) return null;
  return `${hubOrigin(env)}/api/approve?id=${encodeURIComponent(entry.id)}&token=${encodeURIComponent(entry.approveToken)}`;
}

export async function views(env: Env): Promise<Map<string, number>> {
  if (!env.VIEWS) throw new Error('No VIEWS binding.');
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const list = await env.VIEWS.list({ prefix: 'count:', cursor, limit: 1000 });
    keys.push(...list.keys.map((key) => key.name));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor && keys.length < 2000);
  const values = await Promise.all(keys.map((key) => env.VIEWS!.get(key)));
  keys.forEach((key, i) => counts.set(key.slice('count:'.length), Number.parseInt(values[i] ?? '0', 10) || 0));
  return counts;
}

export interface OwnedWorld {
  id: string;
  name: string;
  url: string;
  status: string;
  owner: string | null;
  created_at: number;
  published_at: number | null;
}

export async function ownedWorlds(env: Env): Promise<{ byStatus: { status: string; n: number }[]; rows: OwnedWorld[] }> {
  const [byStatus, rows] = await Promise.all([
    all<{ status: string; n: number }>(env, `select status, count(*) as n from world group by status order by n desc`),
    all<OwnedWorld>(
      env,
      `select w.id, w.name, w.url, w.status, coalesce(u.username, u.email) as owner, w.created_at, w.published_at
       from world w left join "user" u on u.id = w.owner_user_id order by w.updated_at desc limit 200`,
    ),
  ]);
  return { byStatus: byStatus.map((row) => ({ status: row.status, n: Number(row.n) })), rows };
}

// ── Presence ───────────────────────────────────────────────────────────────

export interface RoomReport {
  room: string;
  label: string;
  stats: Result<RoomStats>;
}

/** The lobby plus each listed world's own room (rooms are keyed by the page's origin). */
export async function presence(env: Env, worldUrls: { name: string; url: string }[]): Promise<RoomReport[]> {
  const namespace = env.ROOMS;
  if (!namespace) throw new Error('No ROOMS binding to workers/presence.');
  const rooms: { room: string; label: string }[] = [{ room: 'lobby', label: 'Hub lobby (walk mode)' }];
  const seen = new Set<string>();
  for (const world of worldUrls) {
    let origin: string;
    try {
      origin = new URL(world.url).origin.toLowerCase();
    } catch {
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    rooms.push({ room: `world:${origin}`, label: world.name });
  }
  return Promise.all(
    rooms.slice(0, 60).map(async ({ room, label }) => ({
      room,
      label,
      stats: await attempt(async () => {
        const stub = namespace.get(namespace.idFromName(room)) as unknown as PresenceRoom;
        return stub.stats();
      }),
    })),
  );
}

// ── Ads ────────────────────────────────────────────────────────────────────

export interface AdRow {
  id: string;
  billboard_id: string;
  status: string;
  advertiser_name: string;
  destination_url: string;
  contact_email: string;
  amount_cents: number;
  currency: string;
  created_at: number;
  ends_at: number | null;
}

export async function ads(env: Env) {
  const [byStatus, revenue, recent] = await Promise.all([
    all<{ status: string; n: number }>(env, `select status, count(*) as n from ad_submission group by status order by n desc`),
    all<{ currency: string; cents: number; n: number }>(
      env,
      `select currency, sum(amount_cents) as cents, count(*) as n from ad_submission where captured_at is not null group by currency`,
    ),
    all<AdRow>(
      env,
      `select id, billboard_id, status, advertiser_name, destination_url, contact_email, amount_cents, currency, created_at, ends_at
       from ad_submission order by case status when 'pending' then 0 when 'active' then 1 else 2 end, created_at desc limit 100`,
    ),
  ]);
  return {
    byStatus: byStatus.map((row) => ({ status: row.status, n: Number(row.n) })),
    revenue: revenue.map((row) => ({ currency: row.currency, cents: Number(row.cents), n: Number(row.n) })),
    recent,
  };
}

// ── Federation and avatars ─────────────────────────────────────────────────

export async function federation(env: Env) {
  const at = now(env);
  const [actors, followers, remoteActors, objects, deliveries, failing, interactions, inbox24h, topCreators, errors] = await Promise.all([
    all<{ kind: string; n: number }>(env, `select kind, count(*) as n from ap_actor group by kind`),
    count(env, `select count(*) as n from ap_follower`),
    count(env, `select count(*) as n from ap_remote_actor`),
    count(env, `select count(*) as n from ap_object`),
    count(env, `select count(*) as n from ap_delivery`),
    count(env, `select count(*) as n from ap_delivery where attempts > 0`),
    all<{ type: string; n: number }>(env, `select type, count(*) as n from ap_interaction group by type`),
    count(env, `select count(*) as n from ap_inbox_seen where received_at > ?`, at - DAY),
    all<{ username: string | null; email: string; followers: number }>(
      env,
      `select u.username, u.email, count(f.follower_uri) as followers
       from ap_actor x join "user" u on u.id = x.user_id left join ap_follower f on f.actor_id = x.id
       where x.kind = 'person' group by x.id order by followers desc limit 10`,
    ),
    all<{ inbox: string; attempts: number; last_error: string | null; next_attempt_at: number }>(
      env,
      `select inbox, attempts, last_error, next_attempt_at from ap_delivery where last_error is not null order by next_attempt_at desc limit 20`,
    ),
  ]);
  return {
    actors: actors.map((row) => ({ kind: row.kind, n: Number(row.n) })),
    followers,
    remoteActors,
    objects,
    deliveries,
    failing,
    interactions: interactions.map((row) => ({ type: row.type, n: Number(row.n) })),
    inbox24h,
    topCreators: topCreators.map((row) => ({ ...row, followers: Number(row.followers) })),
    errors,
  };
}

export async function avatars(env: Env) {
  const [connections, total, selected] = await Promise.all([
    all<{ provider: string; status: string; n: number }>(
      env,
      `select provider, status, count(*) as n from avatar_connection group by provider, status order by provider`,
    ),
    count(env, `select count(*) as n from avatar`),
    count(env, `select count(*) as n from avatar where selected = 1`),
  ]);
  return { connections: connections.map((row) => ({ ...row, n: Number(row.n) })), total, selected };
}

// ── Cloudflare analytics (optional: needs an API token) ────────────────────

export interface TrafficDay {
  date: string;
  requests: number;
  pageViews: number;
  bytes: number;
  threats: number;
  uniques: number;
}

export interface Traffic {
  days: TrafficDay[];
  countries: { country: string; requests: number }[];
  workers: { script: string; requests: number; errors: number }[] | null;
}

async function graphql<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await http(env)('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  if (!response.ok || !body.data) throw new Error(`Cloudflare API answered ${response.status}.`);
  return body.data;
}

export async function traffic(env: Env): Promise<Traffic> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new Error('Not connected yet: set CF_API_TOKEN and CF_ZONE_ID (see docs/admin.md).');
  }
  const at = now(env);
  const until = new Date(at).toISOString().slice(0, 10);
  const since = new Date(at - 29 * DAY).toISOString().slice(0, 10);
  type Zone = {
    viewer: {
      zones: {
        httpRequests1dGroups: {
          dimensions: { date: string };
          sum: { requests: number; pageViews: number; bytes: number; threats: number; countryMap: { clientCountryName: string; requests: number }[] };
          uniq: { uniques: number };
        }[];
      }[];
    };
  };
  const zone = await graphql<Zone>(
    env,
    `query ($zone: String!, $since: Date!, $until: Date!) {
      viewer { zones(filter: { zoneTag: $zone }) {
        httpRequests1dGroups(limit: 31, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
          dimensions { date }
          sum { requests pageViews bytes threats countryMap { clientCountryName requests } }
          uniq { uniques }
        }
      } }
    }`,
    { zone: env.CF_ZONE_ID, since, until },
  );
  const groups = zone.viewer.zones[0]?.httpRequests1dGroups ?? [];
  const countries = new Map<string, number>();
  for (const group of groups) {
    for (const entry of group.sum.countryMap ?? []) {
      countries.set(entry.clientCountryName, (countries.get(entry.clientCountryName) ?? 0) + entry.requests);
    }
  }

  let workers: Traffic['workers'] = null;
  if (env.CF_ACCOUNT_ID) {
    type Account = {
      viewer: { accounts: { workersInvocationsAdaptive: { dimensions: { scriptName: string }; sum: { requests: number; errors: number } }[] }[] };
    };
    try {
      const account = await graphql<Account>(
        env,
        `query ($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: { accountTag: $account }) {
            workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $since, datetime_leq: $until }) {
              dimensions { scriptName }
              sum { requests errors }
            }
          } }
        }`,
        { account: env.CF_ACCOUNT_ID, since: new Date(at - DAY).toISOString(), until: new Date(at).toISOString() },
      );
      const scripts = new Map<string, { requests: number; errors: number }>();
      for (const row of account.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
        const entry = scripts.get(row.dimensions.scriptName) ?? { requests: 0, errors: 0 };
        entry.requests += row.sum.requests;
        entry.errors += row.sum.errors;
        scripts.set(row.dimensions.scriptName, entry);
      }
      workers = [...scripts].map(([script, sums]) => ({ script, ...sums })).sort((a, b) => b.requests - a.requests);
    } catch {
      workers = null;
    }
  }

  return {
    days: groups.map((group) => ({
      date: group.dimensions.date,
      requests: group.sum.requests,
      pageViews: group.sum.pageViews,
      bytes: group.sum.bytes,
      threats: group.sum.threats,
      uniques: group.uniq.uniques,
    })),
    countries: [...countries].map(([country, requests]) => ({ country, requests })).sort((a, b) => b.requests - a.requests).slice(0, 12),
    workers,
  };
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface Check {
  name: string;
  url: string;
  /** Statuses that mean "up" (some Workers answer a bare GET with 404 on purpose). */
  expect: number[];
}

export interface CheckResult extends Check {
  status: number | null;
  ms: number;
  up: boolean;
  error?: string;
}

export function serviceChecks(env: Env): Check[] {
  const hub = hubOrigin(env);
  const checks: Check[] = [
    { name: 'Hub', url: `${hub}/`, expect: [200] },
    { name: 'Directory API', url: `${hub}/api/worlds`, expect: [200] },
    { name: 'Accounts (workers/auth)', url: `${hub}/api/account/providers`, expect: [200] },
    { name: 'Federation (workers/federation)', url: `${hub}/.well-known/nodeinfo`, expect: [200] },
    { name: 'Ads (workers/ads)', url: `${hub}/api/ads/billboards`, expect: [200] },
  ];
  if (env.PRESENCE_URL) checks.push({ name: 'Presence (workers/presence)', url: env.PRESENCE_URL, expect: [404, 426] });
  if (env.SCREENSHOT_URL) checks.push({ name: 'Screenshots (workers/screenshot)', url: env.SCREENSHOT_URL, expect: [404] });
  return checks;
}

export async function runChecks(env: Env, checks: Check[], timeoutMs = 5000): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      const started = Date.now();
      try {
        const response = await http(env)(check.url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'WorldMesh-Admin-Healthcheck/1.0' },
        });
        await response.body?.cancel();
        const ms = Date.now() - started;
        const up = check.expect.includes(response.status) || (check.expect.includes(200) && response.status >= 200 && response.status < 400);
        return { ...check, status: response.status, ms, up };
      } catch (error) {
        return { ...check, status: null, ms: Date.now() - started, up: false, error: error instanceof Error ? error.name : 'Error' };
      }
    }),
  );
}

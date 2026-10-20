/**
 * D1 access for the Avatar Wallet. Only references live here: which provider
 * accounts a user connected, the avatars they collected, which one is
 * selected, and the buildings they saved.
 */
import { randomToken, seal } from './crypto';
import type { AvatarProviderId, AvatarRow, BuildingLinkRow, BuildingRow, ConnectionRow, NewConnection, ProviderAvatar, ProviderBuilding } from './types';

export function connectionsOf(db: D1Database, userId: string) {
  return db
    .prepare('select * from avatar_connection where user_id = ?1 order by created_at')
    .bind(userId)
    .all<ConnectionRow>()
    .then((r) => r.results);
}

export function connection(db: D1Database, userId: string, id: unknown) {
  if (typeof id !== 'string') return Promise.resolve(null);
  return db.prepare('select * from avatar_connection where id = ?1 and user_id = ?2').bind(id, userId).first<ConnectionRow>();
}

export function selectedAvatar(db: D1Database, userId: string) {
  return db
    .prepare(
      `select a.*, c.status as connection_status from avatar a
       join avatar_connection c on c.id = a.connection_id
       where a.user_id = ?1 and a.selected = 1`,
    )
    .bind(userId)
    .first<AvatarRow & { connection_status: ConnectionRow['status'] }>();
}

/** Creates or replaces the user's connection to `provider`. Returns its id. */
export async function saveConnection(
  db: D1Database,
  secret: string | undefined,
  userId: string,
  provider: AvatarProviderId,
  account: NewConnection,
): Promise<string> {
  const existing = await db
    .prepare('select id, provider_account_id from avatar_connection where user_id = ?1 and provider = ?2')
    .bind(userId, provider)
    .first<{ id: string; provider_account_id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const tokenEnc = account.credentials ? await seal(secret, 'provider-token-v1', id, account.credentials) : null;
  const now = Date.now();
  const statements = [
    db
      .prepare(
        `insert into avatar_connection
           (id, user_id, provider, provider_account_id, display_name, service_endpoint, token_enc, status, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)
         on conflict (user_id, provider) do update set
           provider_account_id = excluded.provider_account_id,
           display_name = excluded.display_name,
           service_endpoint = excluded.service_endpoint,
           token_enc = excluded.token_enc,
           status = 'active',
           updated_at = excluded.updated_at`,
      )
      .bind(id, userId, provider, account.providerAccountId, account.displayName, account.serviceEndpoint ?? null, tokenEnc, now),
  ];
  // Reconnected as a different account: the old account's avatars and buildings no longer apply.
  if (existing && existing.provider_account_id !== account.providerAccountId) {
    statements.unshift(
      db.prepare('delete from avatar where connection_id = ?1').bind(id),
      db.prepare('delete from building where connection_id = ?1').bind(id),
    );
  }
  await db.batch(statements);
  return id;
}

export async function saveCredentials(
  db: D1Database,
  secret: string | undefined,
  connection: ConnectionRow,
  credentials: unknown | null,
): Promise<void> {
  const tokenEnc = credentials ? await seal(secret, 'provider-token-v1', connection.id, credentials) : null;
  await db
    .prepare('update avatar_connection set token_enc = ?1, status = ?2, updated_at = ?3 where id = ?4')
    .bind(tokenEnc, credentials ? 'active' : 'reconnect', Date.now(), connection.id)
    .run();
  connection.token_enc = tokenEnc;
  connection.status = credentials ? 'active' : 'reconnect';
}

export function markReconnect(db: D1Database, connectionId: string) {
  return db
    .prepare("update avatar_connection set status = 'reconnect', updated_at = ?1 where id = ?2")
    .bind(Date.now(), connectionId)
    .run();
}

export function deleteConnection(db: D1Database, userId: string, id: string) {
  // avatar and building rows cascade.
  return db.prepare('delete from avatar_connection where id = ?1 and user_id = ?2').bind(id, userId).run();
}

/** The user's saved avatars, oldest first. */
export function collectionOf(db: D1Database, userId: string) {
  return db
    .prepare(
      `select a.*, c.status as connection_status from avatar a
       join avatar_connection c on c.id = a.connection_id
       where a.user_id = ?1 order by a.created_at`,
    )
    .bind(userId)
    .all<AvatarRow & { connection_status: ConnectionRow['status'] }>()
    .then((r) => r.results);
}

export async function collectionSize(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('select count(*) as n from avatar where user_id = ?1').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export function isCollected(db: D1Database, connectionId: string, avatarId: string) {
  return db
    .prepare('select 1 as found from avatar where connection_id = ?1 and external_avatar_id = ?2')
    .bind(connectionId, avatarId)
    .first<{ found: number }>()
    .then((row) => !!row);
}

/**
 * Adds `avatar` to the user's collection, or refreshes its details if it is
 * already there. With `select`, it also becomes the one selected avatar.
 */
export async function saveAvatar(db: D1Database, userId: string, connection: ConnectionRow, avatar: ProviderAvatar, select: boolean) {
  const now = Date.now();
  const statements = [
    db
      .prepare(
        `insert into avatar
           (id, user_id, connection_id, provider, external_avatar_id, display_name, thumbnail_url, format, selected, metadata_json, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         on conflict (connection_id, external_avatar_id) do update set
           display_name = excluded.display_name,
           thumbnail_url = excluded.thumbnail_url,
           format = excluded.format,
           selected = max(avatar.selected, excluded.selected),
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        connection.id,
        connection.provider,
        avatar.id,
        avatar.name,
        avatar.thumbnail,
        avatar.format,
        select ? 1 : 0,
        avatar.metadata ? JSON.stringify(avatar.metadata) : null,
        now,
      ),
  ];
  if (select) statements.unshift(db.prepare('update avatar set selected = 0 where user_id = ?1 and selected = 1').bind(userId));
  await db.batch(statements);
}

/** Takes one avatar out of the collection. If it was selected, nothing is selected afterwards. */
export function removeAvatar(db: D1Database, userId: string, connectionId: string, avatarId: string) {
  return db
    .prepare('delete from avatar where user_id = ?1 and connection_id = ?2 and external_avatar_id = ?3')
    .bind(userId, connectionId, avatarId)
    .run();
}

/** Names a saved avatar for this user only; null goes back to the platform's name. */
export function renameAvatar(db: D1Database, userId: string, connectionId: string, avatarId: string, name: string | null) {
  return db
    .prepare('update avatar set custom_name = ?4, updated_at = ?5 where user_id = ?1 and connection_id = ?2 and external_avatar_id = ?3')
    .bind(userId, connectionId, avatarId, name, Date.now())
    .run();
}

/** "Continue without character": the collection stays. */
export function clearSelection(db: D1Database, userId: string) {
  return db.prepare('update avatar set selected = 0 where user_id = ?1 and selected = 1').bind(userId).run();
}

// ── My buildings ─────────────────────────────────────────────────────────────

/** The user's saved buildings, oldest first, with whether their platform is still connected. */
export function buildingsOf(db: D1Database, userId: string) {
  return db
    .prepare(
      `select b.*, c.status as connection_status from building b
       join avatar_connection c on c.id = b.connection_id
       where b.user_id = ?1 order by b.created_at`,
    )
    .bind(userId)
    .all<BuildingRow & { connection_status: ConnectionRow['status'] }>()
    .then((r) => r.results);
}

export async function buildingCount(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('select count(*) as n from building where user_id = ?1').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export function isBuildingSaved(db: D1Database, connectionId: string, externalId: string) {
  return db
    .prepare('select 1 as found from building where connection_id = ?1 and external_id = ?2')
    .bind(connectionId, externalId)
    .first<{ found: number }>()
    .then((row) => !!row);
}

/** Saves `model` to the user's buildings, or refreshes its details if it is already there. Its id stays. */
export function saveBuilding(db: D1Database, userId: string, connection: ConnectionRow, model: ProviderBuilding) {
  const now = Date.now();
  return db
    .prepare(
      `insert into building
         (id, user_id, connection_id, provider, external_id, display_name, thumbnail_url, metadata_json, created_at, updated_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       on conflict (connection_id, external_id) do update set
         display_name = excluded.display_name,
         thumbnail_url = excluded.thumbnail_url,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      `bld_${randomToken(12)}`,
      userId,
      connection.id,
      connection.provider,
      model.id,
      model.name,
      model.thumbnail,
      JSON.stringify({ bytes: model.bytes, sourceUrl: model.sourceUrl }),
      now,
    )
    .run();
}

/** Names a saved building for this user only; null goes back to the platform's name. */
export function renameBuilding(db: D1Database, userId: string, id: string, name: string | null) {
  return db
    .prepare('update building set custom_name = ?3, updated_at = ?4 where user_id = ?1 and id = ?2')
    .bind(userId, id, name, Date.now())
    .run();
}

export function removeBuilding(db: D1Database, userId: string, id: string) {
  return db.prepare('delete from building where user_id = ?1 and id = ?2').bind(userId, id).run();
}

// ── Buildings on worlds ──────────────────────────────────────────────────────

/** All links of the user's buildings, oldest first. */
export function linksOf(db: D1Database, userId: string) {
  return db
    .prepare(
      `select l.* from building_link l join building b on b.id = l.building_id
       where b.user_id = ?1 order by l.created_at`,
    )
    .bind(userId)
    .all<BuildingLinkRow>()
    .then((r) => r.results);
}

export async function linkCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('select count(*) as n from building_link l join building b on b.id = l.building_id where b.user_id = ?1')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function linkOf(db: D1Database, worldUrl: string) {
  return db.prepare('select * from building_link where world_url = ?1').bind(worldUrl).first<BuildingLinkRow>();
}

/**
 * The world shows `buildingId` from now on: a new link, or one that replaces
 * the world's previous building. No review first (docs/specs/buildings.md
 * §5.2): reports and hiding take a bad one down.
 */
export function saveLink(db: D1Database, worldUrl: string, buildingId: string) {
  const now = Date.now();
  return db
    .prepare(
      `insert into building_link (world_url, building_id, status, checked_at, created_at, updated_at)
       values (?1, ?2, 'approved', ?3, ?3, ?3)
       on conflict (world_url) do update set
         building_id = excluded.building_id, status = 'approved', sha256 = null, version = null, portal_json = null,
         reason = null, checked_at = excluded.checked_at, reviewed_at = null, reviewed_by = null,
         created_at = excluded.created_at, updated_at = excluded.updated_at`,
    )
    .bind(worldUrl, buildingId, now)
    .run();
}

/** Linked again while it stands: nothing changes. */
export function touchLink(db: D1Database, worldUrl: string) {
  const now = Date.now();
  return db.prepare('update building_link set checked_at = ?2, updated_at = ?2 where world_url = ?1').bind(worldUrl, now).run();
}

/** Takes one of the user's buildings off a world. */
export function unlink(db: D1Database, userId: string, buildingId: string, worldUrl: string) {
  return db
    .prepare(
      `delete from building_link where world_url = ?1 and building_id = ?2
       and building_id in (select id from building where user_id = ?3)`,
    )
    .bind(worldUrl, buildingId, userId)
    .run();
}

/** Worlds whose building visitors may see, with the file it must be. */
export function approvedLinks(db: D1Database) {
  return db
    .prepare("select world_url, sha256 from building_link where status = 'approved' order by world_url")
    .all<{ world_url: string; sha256: string | null }>()
    .then((r) => r.results);
}

/** Approved links of these worlds, with their building and its connection, for resolving. */
export function approvedFor(db: D1Database, worldUrls: string[]) {
  return db
    .prepare(
      `select l.world_url, l.sha256, l.version, b.*,
         c.user_id as c_user_id, c.provider_account_id as c_provider_account_id, c.display_name as c_display_name,
         c.service_endpoint as c_service_endpoint, c.token_enc as c_token_enc, c.status as c_status,
         c.created_at as c_created_at, c.updated_at as c_updated_at
       from building_link l
       join building b on b.id = l.building_id
       join avatar_connection c on c.id = b.connection_id
       where l.world_url in (select value from json_each(?1)) and l.status = 'approved'`,
    )
    .bind(JSON.stringify(worldUrls))
    .all<ApprovedRow>()
    .then((r) => r.results);
}

/**
 * A reviewer pinned the file, and its owner replaced it since: the new one
 * stands instead, unpinned. Nobody reviews it again first (§5.3).
 */
export function unpin(db: D1Database, worldUrl: string, version: string) {
  return db
    .prepare("update building_link set sha256 = null, version = null, updated_at = ?3 where world_url = ?1 and version = ?2 and status = 'approved'")
    .bind(worldUrl, version, Date.now())
    .run();
}

/** Links for review, waiting ones first. */
export function reviewQueue(db: D1Database, limit = 200) {
  return db
    .prepare(
      `select * from (
         select l.world_url, l.status, l.reason, l.created_at, l.updated_at, l.reviewed_at,
           b.id as building_id, coalesce(b.custom_name, b.display_name) as building_name, b.provider,
           (select count(*) from building_report r
            where r.world_url = l.world_url and r.building_id = l.building_id and r.status = 'open') as reports
         from building_link l join building b on b.id = l.building_id
       )
       order by case when status = 'pending' then 0 when reports > 0 then 1 when status = 'approved' then 2 else 3 end, updated_at desc
       limit ?1`,
    )
    .bind(limit)
    .all<ReviewQueueRow>()
    .then((r) => r.results);
}

/** One link, its building, the building's connection and its owner, for review. */
export function reviewLink(db: D1Database, worldUrl: string) {
  return db
    .prepare(
      `select l.world_url, l.status, l.sha256, l.version, l.reason, l.created_at as link_created_at,
         l.reviewed_at, l.reviewed_by, b.*,
         c.user_id as c_user_id, c.provider_account_id as c_provider_account_id, c.display_name as c_display_name,
         c.service_endpoint as c_service_endpoint, c.token_enc as c_token_enc, c.status as c_status,
         c.created_at as c_created_at, c.updated_at as c_updated_at,
         u.name as owner_name, u.email as owner_email, u.username as owner_username, u."emailVerified" as owner_email_verified
       from building_link l
       join building b on b.id = l.building_id
       join avatar_connection c on c.id = b.connection_id
       join "user" u on u.id = b.user_id
       where l.world_url = ?1`,
    )
    .bind(worldUrl)
    .first<ReviewRow>();
}

/** A reviewer's decision, only while the world still links the building they looked at. A statement, to batch. */
export function decideLink(
  db: D1Database,
  worldUrl: string,
  buildingId: string,
  decision: { status: 'approved' | 'rejected' | 'hidden'; sha256: string | null; version: string | null; portalJson: string | null; reason: string | null; by: string },
) {
  const now = Date.now();
  return db
    .prepare(
      `update building_link set status = ?3, sha256 = ?4, version = ?5, portal_json = ?6, reason = ?7,
         reviewed_at = ?8, reviewed_by = ?9, updated_at = ?8
       where world_url = ?1 and building_id = ?2`,
    )
    .bind(worldUrl, buildingId, decision.status, decision.sha256, decision.version, decision.portalJson, decision.reason, now, decision.by);
}

/** The connection columns of a joined row, as a connection. */
export function connectionFrom(row: ApprovedRow | ReviewRow): ConnectionRow {
  return {
    id: row.connection_id,
    user_id: row.c_user_id,
    provider: row.provider,
    provider_account_id: row.c_provider_account_id,
    display_name: row.c_display_name,
    service_endpoint: row.c_service_endpoint,
    token_enc: row.c_token_enc,
    status: row.c_status,
    created_at: row.c_created_at,
    updated_at: row.c_updated_at,
  };
}

interface JoinedConnection {
  c_user_id: string;
  c_provider_account_id: string;
  c_display_name: string | null;
  c_service_endpoint: string | null;
  c_token_enc: string | null;
  c_status: ConnectionRow['status'];
  c_created_at: number;
  c_updated_at: number;
}

export interface ApprovedRow extends BuildingRow, JoinedConnection {
  world_url: string;
  /** Pinned by a reviewer, or null: shown as it is on its platform. */
  sha256: string | null;
  version: string | null;
}

export interface ReviewRow extends BuildingRow, JoinedConnection {
  world_url: string;
  status: BuildingLinkRow['status'];
  sha256: string | null;
  version: string | null;
  reason: string | null;
  link_created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_username: string | null;
  owner_email_verified: number | boolean | null;
}

export interface ReviewQueueRow {
  /** Open reports on it. */
  reports: number;
  world_url: string;
  status: BuildingLinkRow['status'];
  reason: string | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  building_id: string;
  building_name: string | null;
  provider: string;
}

// ── Reports ──────────────────────────────────────────────────────────────────

/** Why a visitor reports a building (docs/specs/buildings.md §8). */
export const REPORT_REASONS = ['offensive', 'sexual', 'violent', 'copyright', 'broken', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * A visitor's report on the building standing on `link`'s world. One open
 * report per person: reporting again changes nothing. Returns whether it is
 * new, and how many open reports the building has now.
 */
export async function saveReport(
  db: D1Database,
  link: Pick<BuildingLinkRow, 'world_url' | 'building_id' | 'sha256'>,
  reporterId: string,
  reason: ReportReason,
  note: string | null,
): Promise<{ created: boolean; open: number }> {
  const [insert, count] = await db.batch<{ n: number }>([
    db
      .prepare(
        `insert into building_report (id, world_url, building_id, sha256, reporter_id, reason, note, status, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8)
         on conflict do nothing`,
      )
      .bind(`rpt_${randomToken(12)}`, link.world_url, link.building_id, link.sha256, reporterId, reason, note, Date.now()),
    db
      .prepare("select count(*) as n from building_report where world_url = ?1 and building_id = ?2 and status = 'open'")
      .bind(link.world_url, link.building_id),
  ]);
  return { created: insert.meta.changes > 0, open: count.results[0]?.n ?? 0 };
}

/** The open reports on a world's building, oldest first, with who made them. */
export function openReports(db: D1Database, worldUrl: string, buildingId: string) {
  return db
    .prepare(
      `select r.id, r.reason, r.note, r.sha256, r.created_at, u.username as reporter_username, u.email as reporter_email
       from building_report r left join "user" u on u.id = r.reporter_id
       where r.world_url = ?1 and r.building_id = ?2 and r.status = 'open' order by r.created_at`,
    )
    .bind(worldUrl, buildingId)
    .all<OpenReportRow>()
    .then((r) => r.results);
}

/** Closes a building's open reports: `actioned` when it came down, `dismissed` when it stays. */
export function resolveReports(db: D1Database, worldUrl: string, buildingId: string, status: 'dismissed' | 'actioned', by: string) {
  return db
    .prepare(
      `update building_report set status = ?3, resolved_at = ?4, resolved_by = ?5
       where world_url = ?1 and building_id = ?2 and status = 'open'`,
    )
    .bind(worldUrl, buildingId, status, Date.now(), by);
}

export interface OpenReportRow {
  id: string;
  reason: ReportReason;
  note: string | null;
  sha256: string | null;
  created_at: number;
  reporter_username: string | null;
  reporter_email: string | null;
}

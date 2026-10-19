/**
 * D1 access for the Avatar Wallet. Only references live here: which provider
 * accounts a user connected, the avatars they collected, which one is
 * selected, and the buildings they saved.
 */
import { randomToken, seal } from './crypto';
import type { AvatarProviderId, AvatarRow, BuildingRow, ConnectionRow, NewConnection, ProviderAvatar, ProviderBuilding } from './types';

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

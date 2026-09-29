/**
 * Announcing a world to the fediverse: "Elias published Example World".
 *
 * Never automatic. It runs only when POST /ap/admin/announce names a world
 * that is `published` in D1 and owned by a creator with a username. Each world
 * is announced at most once (ap_object.world_id is unique).
 */
import { ensurePersonActor, escapeHtml, linkHtml } from './actors';
import { enqueueToFollowersStatement } from './delivery';
import { AS_CONTEXT, AS_PUBLIC, randomId, uris, type Env } from './env';

interface WorldRow {
  id: string;
  name: string;
  url: string;
  description: string | null;
  cover_url: string | null;
  status: string;
  published_at: number | null;
  owner_user_id: string | null;
  username: string | null;
  owner_name: string | null;
}

export type AnnounceResult =
  | { ok: true; created: boolean; objectId: string; activityId: string; deliveries: number }
  | { ok: false; status: number; error: string };

export async function announceWorld(env: Env, worldId: string): Promise<AnnounceResult> {
  const world = await env.DB.prepare(
    `select w.*, u.username, nullif(trim(u.name), '') as owner_name
     from world w left join "user" u on u.id = w.owner_user_id where w.id = ?`,
  )
    .bind(worldId)
    .first<WorldRow>();
  if (!world) return { ok: false, status: 404, error: 'World not found.' };
  if (world.status !== 'published') return { ok: false, status: 409, error: 'World is not published.' };
  if (!world.owner_user_id || !world.username) {
    return { ok: false, status: 409, error: 'World has no owner with a username.' };
  }

  const existing = await findAnnouncement(env, world.id);
  if (existing) return existing;

  const actor = await ensurePersonActor(env, world.owner_user_id);
  const actorUri = uris.actor(env, actor.id);
  const objectId = randomId();
  const activityId = randomId();
  const published = new Date(world.published_at ?? Date.now()).toISOString();
  const canonical = uris.worldPage(env, world.username, world.id);

  const note = {
    id: uris.object(env, objectId),
    type: 'Note',
    attributedTo: actorUri,
    to: [AS_PUBLIC],
    cc: [uris.followers(env, actor.id)],
    published,
    url: canonical,
    content: noteContent(world, canonical),
    ...(coverAttachment(world) ?? {}),
  };
  const create = {
    '@context': AS_CONTEXT,
    id: uris.activity(env, activityId),
    type: 'Create',
    actor: actorUri,
    published,
    to: note.to,
    cc: note.cc,
    object: note,
  };

  const now = Date.now();
  try {
    // One batch, so the object, its Create and its deliveries appear together or not at all.
    const [, , deliveries] = await env.DB.batch([
      env.DB.prepare(
        'insert into ap_object (id, actor_id, world_id, type, json, published_at) values (?1, ?2, ?3, ?4, ?5, ?6)',
      ).bind(objectId, actor.id, world.id, 'Note', JSON.stringify({ '@context': AS_CONTEXT, ...note }), now),
      env.DB.prepare(
        'insert into ap_activity (id, actor_id, type, object_id, public, json, published_at) values (?1, ?2, ?3, ?4, 1, ?5, ?6)',
      ).bind(activityId, actor.id, 'Create', objectId, JSON.stringify(create), now),
      enqueueToFollowersStatement(env.DB, activityId, actor.id),
    ]);
    return { ok: true, created: true, objectId, activityId, deliveries: deliveries.meta.changes ?? 0 };
  } catch (error) {
    // A concurrent announce of the same world won the unique world_id.
    const winner = String(error).includes('UNIQUE') ? await findAnnouncement(env, world.id) : null;
    if (winner) return winner;
    throw error;
  }
}

async function findAnnouncement(env: Env, worldId: string): Promise<AnnounceResult | null> {
  const row = await env.DB.prepare(
    `select o.id as object_id, a.id as activity_id from ap_object o
     join ap_activity a on a.object_id = o.id and a.type = 'Create' where o.world_id = ?`,
  )
    .bind(worldId)
    .first<{ object_id: string; activity_id: string }>();
  return row && { ok: true, created: false, objectId: row.object_id, activityId: row.activity_id, deliveries: 0 };
}

function noteContent(world: WorldRow, canonical: string): string {
  const who = escapeHtml(world.owner_name || world.username || 'A creator');
  let html = `<p>${who} published ${linkHtml(canonical, world.name)} on WorldMesh.</p>`;
  if (world.description) html += `<p>${escapeHtml(world.description)}</p>`;
  html += `<p>Walk in: ${linkHtml(world.url)}</p>`;
  return html;
}

function coverAttachment(world: WorldRow) {
  const cover = world.cover_url;
  if (!cover || !/^https:\/\//i.test(cover)) return null;
  const extension = new URL(cover).pathname.split('.').pop()?.toLowerCase();
  const mediaType =
    { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[extension ?? ''] ??
    undefined;
  return {
    attachment: [{ type: 'Image', url: cover, ...(mediaType ? { mediaType } : {}), name: `Cover of ${world.name}` }],
  };
}

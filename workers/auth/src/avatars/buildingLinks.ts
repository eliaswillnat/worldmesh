/**
 * Buildings on worlds (docs/specs/buildings.md §5 and §7.2): linking a saved
 * building to a world, which its world's own manifest has to agree to, and
 * where visitors' browsers download approved ones from.
 *
 * Only pointers again: the manifest is read here (a small JSON file), but
 * never the model, which goes straight from the platform to the browser.
 */
import type { Env } from '../auth';
import { reviewersWaiting, tellOwner } from './buildingMail';
import { jsonObject, providerFetch, UnsafeUrlError } from './net';
import { context, PROVIDERS, type WaitUntil } from './routes';
import * as store from './store';
import { AvatarError, type BuildingFile } from './types';

/** Where a world's manifest may be, in the order the hub reads them. */
const MANIFEST_PATHS = ['/.well-known/worldmesh.json', '/worldmesh.json'];
/** A manifest names its building again at least this often, or loses it (§5.1). */
const RECHECK_MS = 24 * 60 * 60_000;
/** Manifests re-read per request to the approved list, at most. */
const RECHECKS_PER_REQUEST = 3;
/** A resolved file is shared with other visitors for this long, at most (seconds). */
const FILE_CACHE_SECONDS = 300;
/** …and never closer than this to its URL expiring. */
const FILE_EXPIRY_MARGIN_SECONDS = 60;

/**
 * A world's URL as the hub compares them (apps/hub/src/worlds/listing.ts,
 * canonicalUrl): lower-case host, no hash, no trailing slash. https only.
 */
export function canonicalWorldUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  url.hash = '';
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

/**
 * What the world's manifest says about its building: `read` once a manifest
 * was found at all, and the building id it names, if any.
 */
export async function manifestBuilding(world: string, ownHost: string): Promise<{ read: boolean; building: string | null }> {
  for (const path of MANIFEST_PATHS) {
    let manifest: Record<string, unknown> | null;
    try {
      const result = await providerFetch(new URL(path, world).toString(), {
        ownHost,
        maxBytes: 64 * 1024,
        timeoutMs: 6000,
        headers: { Accept: 'application/json' },
      });
      manifest = result.status === 200 ? jsonObject(result) : null;
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error;
      manifest = null;
    }
    if (manifest) return { read: true, building: typeof manifest.building === 'string' ? manifest.building.trim() : null };
  }
  return { read: false, building: null };
}

/**
 * Reads again the manifests of a few links not checked for a day, and takes a
 * building down where its world no longer names it. A manifest that can't be
 * read leaves the link as it is: the site may just be down.
 */
export async function recheckStale(env: Env, origin: string): Promise<void> {
  const stale = await store.staleLinks(env.DB, Date.now() - RECHECK_MS, RECHECKS_PER_REQUEST);
  for (const link of stale) {
    if (!(await store.claimLink(env.DB, link.world_url, link.checked_at))) continue;
    try {
      const manifest = await manifestBuilding(link.world_url, new URL(origin).host);
      if (manifest.read && manifest.building !== link.building_id) await store.dropLink(env.DB, link.world_url, link.building_id);
    } catch (error) {
      console.error('building manifest re-check failed', link.world_url, error);
    }
  }
}

/** Where to download a world's approved building now, and the hash it must have. */
export interface ResolvedBuilding {
  modelUrl: string;
  /** ISO 8601, or null if `modelUrl` does not expire. */
  expiresAt: string | null;
  sha256: string;
}

/**
 * The approved buildings of `worlds` (canonical URLs), where visitors can
 * download them. A world missing from the answer keeps its default block.
 */
export async function resolveWorlds(env: Env, exec: WaitUntil, origin: string, worlds: string[]): Promise<Record<string, ResolvedBuilding>> {
  const rows = await store.approvedFor(env.DB, worlds);
  const answers = await Promise.all(
    rows.map(async (row): Promise<[string, ResolvedBuilding] | null> => {
      try {
        const file = await approvedFile(env, exec, origin, row);
        if (!file) return null;
        if (row.version && file.version && file.version !== row.version) {
          const { meta } = await store.sendBackToReview(env.DB, row.world_url, row.sha256, 'Its file changed after it was approved, so it is being reviewed again.');
          if (meta.changes) {
            exec.waitUntil(
              Promise.all([reviewersWaiting(env, origin, row.world_url, row.id, 'changed'), tellOwner(env, origin, row.world_url, row.id, 'changed', null)]).catch((error) =>
                console.error('changed-file email failed', error),
              ),
            );
          }
          return null;
        }
        return [row.world_url, { modelUrl: file.modelUrl, expiresAt: file.expiresAt ? new Date(file.expiresAt).toISOString() : null, sha256: row.sha256 }];
      } catch (error) {
        if (error instanceof AvatarError) {
          if (error.reconnect) await store.markReconnect(env.DB, row.connection_id);
        } else {
          console.error('building resolve failed', row.world_url, error);
        }
        return null;
      }
    }),
  );
  return Object.fromEntries(answers.filter((answer): answer is [string, ResolvedBuilding] => !!answer));
}

/**
 * An approved building's file, asked of its platform at most every few
 * minutes: visitors share it, rather than each calling the platform with
 * the owner's account. Still only a pointer; the file goes from the
 * platform to each browser.
 */
async function approvedFile(env: Env, exec: WaitUntil, origin: string, row: store.ApprovedRow): Promise<BuildingFile | null> {
  const provider = PROVIDERS[row.provider];
  if (!provider?.isConfigured(env) || !provider.resolveBuilding || row.c_status !== 'active') return null;
  // Per approved hash, so a building approved again never reads the file cached for the last approval.
  const key = new Request(`${origin}/api/account/building/_file/${encodeURIComponent(row.id)}/${row.sha256}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached) return (await cached.json()) as BuildingFile;
  const file = await provider.resolveBuilding(context(env, exec, origin, provider.id), store.connectionFrom(row), row);
  if (file && cache) {
    const left = file.expiresAt ? Math.floor((file.expiresAt - Date.now()) / 1000) - FILE_EXPIRY_MARGIN_SECONDS : FILE_CACHE_SECONDS;
    const seconds = Math.min(FILE_CACHE_SECONDS, left);
    if (seconds >= 30) {
      const response = new Response(JSON.stringify(file), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}` } });
      exec.waitUntil(cache.put(key, response).catch(() => undefined));
    }
  }
  return file;
}

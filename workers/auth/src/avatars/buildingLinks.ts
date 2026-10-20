/**
 * Buildings on worlds (docs/specs/buildings.md §5 and §7.2): the worlds' URLs
 * as the hub compares them, and where visitors' browsers download approved
 * buildings from. Only pointers: the model goes straight from the platform
 * to the browser.
 */
import type { Env } from '../auth';
import { context, PROVIDERS, type WaitUntil } from './routes';
import * as store from './store';
import { AvatarError, type BuildingFile } from './types';

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

/** Where to download a world's building now, and what the file is. */
export interface ResolvedBuilding {
  modelUrl: string;
  /** ISO 8601, or null if `modelUrl` does not expire. */
  expiresAt: string | null;
  /** The hash a reviewer pinned it to, or null: any file the platform has. */
  sha256: string | null;
  /** What the platform says the file is (a blob CID, a GLB size), for caching. */
  version: string | null;
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
        // Pinned by a reviewer, then replaced by its owner: the new file stands, unpinned.
        let sha256 = row.sha256;
        if (row.version && file.version && file.version !== row.version) {
          await store.unpin(env.DB, row.world_url, row.version);
          sha256 = null;
        }
        const expiresAt = file.expiresAt ? new Date(file.expiresAt).toISOString() : null;
        return [row.world_url, { modelUrl: file.modelUrl, expiresAt, sha256, version: file.version }];
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

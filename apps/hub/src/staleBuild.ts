/**
 * Each deploy replaces the hub's build, and the previous build's hashed chunks
 * go with it. A tab opened before the deploy still runs the old index, so its
 * next lazy import 404s. One reload picks up the new build; this guard makes
 * sure a chunk that keeps failing for some other reason never reloads in a loop.
 */

/** sessionStorage: when this tab last reloaded for a chunk that would not load. */
export const STALE_BUILD_RELOAD_KEY = 'worldmesh.staleBuildReload';
/** Failing again this soon after that reload is not a stale build: stay on the page. */
export const STALE_BUILD_RELOAD_WINDOW_MS = 60_000;

type ReloadStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether to reload now. Records the reload, so the next failure within the window says no. */
export function claimStaleBuildReload(storage: ReloadStorage, now: number): boolean {
  const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY));
  // Missing or unreadable (NaN) never blocks; nor does a time ahead of now (clock moved back).
  if (last <= now && now - last < STALE_BUILD_RELOAD_WINDOW_MS) return false;
  storage.setItem(STALE_BUILD_RELOAD_KEY, String(now));
  return true;
}

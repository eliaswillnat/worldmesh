/**
 * Hub visit counting: who may POST an increment for `worldmesh:hub`.
 * Display of the public total is separate (GET /views) and always allowed.
 */

/** Views-worker key for visits to the hub itself; not a URL, so it never matches a world. */
export const HUB_VISIT_KEY = 'worldmesh:hub';

/** localStorage flag / ?wm_nocount=1 — QA on production skips hub-visit increments. */
export const HUB_NOCOUNT_KEY = 'worldmesh.hubNocount';
export const HUB_NOCOUNT_PARAM = 'wm_nocount';

/** Only the public production hub hostname should bump the visit counter. */
export function isProductionHubHost(hostname: string): boolean {
  return hostname === 'worldmesh.net' || hostname === 'www.worldmesh.net';
}

type NocountStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Persist ?wm_nocount=1 so agents/humans testing production do not keep
 * bumping the counter on later loads. ?wm_nocount=0 clears the flag.
 */
export function syncHubNocountFromQuery(search: string, storage: NocountStorage): void {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has(HUB_NOCOUNT_PARAM)) return;
  const raw = params.get(HUB_NOCOUNT_PARAM);
  if (raw === '0' || raw === 'false') {
    storage.removeItem(HUB_NOCOUNT_KEY);
  } else {
    storage.setItem(HUB_NOCOUNT_KEY, '1');
  }
}

/**
 * Whether this page load should POST an increment for the hub visit key.
 * Non-production hosts and QA opt-out still show the public total via GET.
 */
export function shouldCountHubVisit(
  hostname: string,
  search: string,
  storage: NocountStorage,
): boolean {
  try {
    syncHubNocountFromQuery(search, storage);
    if (storage.getItem(HUB_NOCOUNT_KEY) === '1') return false;
  } catch {
    // Ignore storage / URL failures; fall through to host check.
  }
  return isProductionHubHost(hostname);
}

import type { BuildingDirectory, ResolvedBuilding } from './buildings';

/**
 * The hub's view of worlds' approved buildings (docs/specs/buildings.md §7.2),
 * from workers/auth on the hub's own origin. Both answers are pointers: the
 * files come from the platforms they live on, straight to this browser.
 */

const BASE = '/api/account/building';

export const hubBuildingDirectory: BuildingDirectory = {
  async approved() {
    const response = await fetch(`${BASE}/worlds`, { credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return approvedFrom(await response.json());
  },

  async resolve(worlds) {
    const response = await fetch(`${BASE}/resolve`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worlds }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return resolvedFrom(await response.json());
  },
};

const HASH = /^[0-9a-f]{64}$/;

/** `GET /worlds`: world URL → the SHA-256 its building must have. Anything malformed is left out. */
export function approvedFrom(body: unknown): Map<string, string> {
  const worlds = (body as { worlds?: unknown } | null)?.worlds;
  const approved = new Map<string, string>();
  if (!Array.isArray(worlds)) return approved;
  for (const entry of worlds as Array<{ url?: unknown; sha256?: unknown }>) {
    if (typeof entry?.url === 'string' && typeof entry.sha256 === 'string' && HASH.test(entry.sha256)) approved.set(entry.url, entry.sha256);
  }
  return approved;
}

/** `POST /resolve`: world URL → where to download its building, until when. Only https links. */
export function resolvedFrom(body: unknown): Map<string, ResolvedBuilding> {
  const buildings = (body as { buildings?: unknown } | null)?.buildings;
  const resolved = new Map<string, ResolvedBuilding>();
  if (!buildings || typeof buildings !== 'object') return resolved;
  for (const [world, value] of Object.entries(buildings as Record<string, { modelUrl?: unknown; expiresAt?: unknown; sha256?: unknown }>)) {
    if (typeof value?.modelUrl !== 'string' || !value.modelUrl.startsWith('https://')) continue;
    if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) continue;
    const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
    resolved.set(world, { modelUrl: value.modelUrl, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, sha256: value.sha256 });
  }
  return resolved;
}

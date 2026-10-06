/** Relay caps `/occupancy` at this many origins per request (MAX_OCCUPANCY_ORIGINS). */
export const OCCUPANCY_BATCH_SIZE = 50;

export interface OccupancyInfo {
  count: number;
  cap: number;
}

export interface OccupancyResult {
  /** Occupancy keyed by lowercase origin, from every batch that succeeded. */
  occupancy: Map<string, OccupancyInfo>;
  /** Origins whose batch failed (network error or non-OK response). */
  failed: string[];
}

export type OccupancyFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Dedupe origins and split them into relay-sized batches. */
export function batchOrigins(origins: Iterable<string>, size = OCCUPANCY_BATCH_SIZE): string[][] {
  const unique = [...new Set(origins)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += size) batches.push(unique.slice(i, i + size));
  return batches;
}

/**
 * Fetch occupancy for any number of origins, one request per batch of 50, in parallel.
 * A failed batch is reported in `failed` instead of failing the rest. Throws if aborted.
 */
export async function fetchOccupancy(
  base: string,
  origins: Iterable<string>,
  signal: AbortSignal,
  fetchFn: OccupancyFetch = fetch,
): Promise<OccupancyResult> {
  const occupancy = new Map<string, OccupancyInfo>();
  const failed: string[] = [];
  const batches = batchOrigins(origins);
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const res = await fetchFn(`${base}/occupancy?origins=${encodeURIComponent(batch.join(','))}`, { signal });
      if (!res.ok) throw new Error(`occupancy ${res.status}`);
      return (await res.json()) as Record<string, { count?: unknown; cap?: unknown }>;
    }),
  );
  signal.throwIfAborted();
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed.push(...batches[i]);
      return;
    }
    for (const [origin, value] of Object.entries(result.value ?? {})) {
      const count = Number(value?.count);
      const cap = Number(value?.cap);
      if (!Number.isFinite(count) || !Number.isFinite(cap)) continue;
      occupancy.set(origin.toLowerCase(), { count, cap });
    }
  });
  return { occupancy, failed };
}

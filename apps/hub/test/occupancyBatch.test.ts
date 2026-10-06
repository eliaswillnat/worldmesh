import { describe, expect, it } from 'vitest';
import { OCCUPANCY_BATCH_SIZE, batchOrigins, fetchOccupancy, type OccupancyFetch } from '../src/walk/occupancy.ts';

const origin = (i: number) => `https://w${i}.example`;
const originsOf = (url: string) => new URL(url).searchParams.get('origins')!.split(',');

function fakeFetch(fail: (batch: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const fn: OccupancyFetch = async (url) => {
    const batch = originsOf(url);
    calls.push(batch);
    if (fail(batch)) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify(Object.fromEntries(batch.map((o) => [o, { count: 1, cap: 10 }]))));
  };
  return { fn, calls };
}

describe('batchOrigins', () => {
  it('dedupes and splits into batches of 50', () => {
    const list = [...Array.from({ length: 120 }, (_, i) => origin(i)), origin(0), origin(5)];
    const batches = batchOrigins(list);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(new Set(batches.flat()).size).toBe(120);
  });

  it('returns no batches for no origins', () => {
    expect(batchOrigins([])).toEqual([]);
  });
});

describe('fetchOccupancy', () => {
  it('fetches every batch and merges results (10,000 worlds)', async () => {
    const list = Array.from({ length: 10_000 }, (_, i) => origin(i));
    const { fn, calls } = fakeFetch();
    const { occupancy, failed } = await fetchOccupancy('https://relay', list, new AbortController().signal, fn);
    expect(calls).toHaveLength(10_000 / OCCUPANCY_BATCH_SIZE);
    expect(calls.every((b) => b.length <= OCCUPANCY_BATCH_SIZE)).toBe(true);
    expect(occupancy.size).toBe(10_000);
    expect(failed).toEqual([]);
  });

  it('keeps successful batches when one fails', async () => {
    const list = Array.from({ length: 120 }, (_, i) => origin(i));
    const { fn } = fakeFetch((batch) => batch.includes(origin(60)));
    const { occupancy, failed } = await fetchOccupancy('https://relay', list, new AbortController().signal, fn);
    expect(occupancy.size).toBe(70);
    expect(failed).toHaveLength(50);
    expect(failed).toContain(origin(60));
  });

  it('treats network errors as a failed batch', async () => {
    const list = Array.from({ length: 60 }, (_, i) => origin(i));
    let n = 0;
    const fn: OccupancyFetch = async (url) => {
      if (n++ === 0) throw new TypeError('network');
      return new Response(JSON.stringify(Object.fromEntries(originsOf(url).map((o) => [o, { count: 1, cap: 2 }]))));
    };
    const { occupancy, failed } = await fetchOccupancy('https://relay', list, new AbortController().signal, fn);
    expect(failed).toHaveLength(50);
    expect(occupancy.size).toBe(10);
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    const fn: OccupancyFetch = (_url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const pending = fetchOccupancy('https://relay', [origin(1)], controller.signal, fn);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

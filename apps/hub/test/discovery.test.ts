import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEMENT_CONFIG, placeTower, type PlacementSlot } from '../src/discovery/placement';
import { NO_SIGNALS, RankingService, bucket, type SignalSource } from '../src/discovery/ranking';
import { RotationClock } from '../src/discovery/rotation';
import { PlacementService } from '../src/discovery/service';
import { CATEGORIES } from '../src/worlds/categories';
import { MemoryWorldRepository } from '../src/worlds/repository';
import type { WorldRecordInput } from '../src/worlds/listing';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 12);

function records(count: number, category = 'games', creators = count): WorldRecordInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${String(i).padStart(4, '0')}`,
    name: `World ${i}`,
    url: `https://example${i}.test/`,
    creator: `creator-${i % creators}`,
    categories: [category],
    addedAt: new Date(NOW - (i + 1) * 3 * 24 * HOUR).toISOString(),
  }));
}

function slots(floors: number, perFloor: number, band: PlacementSlot['band'] = 'regular'): PlacementSlot[] {
  const list: PlacementSlot[] = [];
  for (let floor = 0; floor < floors; floor++) {
    for (let d = 0; d < perFloor; d++) {
      list.push({ id: `games:f${floor}:d${d}`, floor, band, strategy: d % 2 ? 'fresh' : 'discovery', priority: d * 1e7 + floor });
    }
  }
  return list;
}

function setup(recordList: WorldRecordInput[], slotList: PlacementSlot[], signals: SignalSource = NO_SIGNALS) {
  const repository = new MemoryWorldRepository();
  repository.merge(recordList);
  const clock = new RotationClock({ intervalMs: 6 * HOUR, epochMs: Date.UTC(2026, 0, 1) }, () => NOW);
  const service = new PlacementService({ repository, ranking: new RankingService(), signals, clock, config: DEFAULT_PLACEMENT_CONFIG });
  service.setTowers([{ towerId: 'games', categoryId: 'games', slots: slotList }]);
  return { repository, clock, service };
}

describe('placement', () => {
  it('is deterministic for the same window, whatever order windows are asked in', () => {
    const a = setup(records(60), slots(10, 8));
    const b = setup(records(60), slots(10, 8));
    const w = a.clock.current();
    b.service.placement('games', w + 3);
    b.service.placement('games', w - 1);
    expect([...b.service.placement('games', w)]).toEqual([...a.service.placement('games', w)]);
  });

  it('changes between rotation windows', () => {
    const { service, clock } = setup(records(60), slots(10, 8));
    const w = clock.current();
    const first = [...service.placement('games', w).values()].map((a) => a.listingId);
    const next = [...service.placement('games', w + 1).values()].map((a) => a.listingId);
    expect(first).not.toEqual(next);
  });

  it('caps appearances per window and never repeats a world on one floor', () => {
    const { service, clock } = setup(records(12), slots(10, 8));
    const placement = service.placement('games', clock.current());
    const counts = new Map<string, number>();
    const perFloor = new Map<number, Set<string>>();
    for (const assignment of placement.values()) {
      counts.set(assignment.listingId, (counts.get(assignment.listingId) ?? 0) + 1);
      const floor = Number(assignment.slotId.split(':f')[1].split(':')[0]);
      const seen = perFloor.get(floor) ?? new Set();
      expect(seen.has(assignment.listingId)).toBe(false);
      seen.add(assignment.listingId);
      perFloor.set(floor, seen);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(DEFAULT_PLACEMENT_CONFIG.maxAppearancesPerWindow);
    // 12 worlds × 2 appearances fill 24 of the 80 doors; the rest stand empty.
    expect(placement.size).toBe(24);
  });

  it('spreads scarce worlds one per floor before doubling up', () => {
    const { service, clock } = setup(records(3), slots(10, 8));
    const placement = service.placement('games', clock.current());
    const floors = new Set([...placement.values()].map((a) => a.slotId.split(':')[1]));
    expect(floors.size).toBe(placement.size);
  });

  it('limits doors per creator on a floor', () => {
    const { service, clock } = setup(records(40, 'games', 2), slots(4, 8));
    const placement = service.placement('games', clock.current());
    const perFloorCreator = new Map<string, number>();
    for (const assignment of placement.values()) {
      const floor = assignment.slotId.split(':')[1];
      const creator = Number(assignment.listingId.slice(1)) % 2;
      const key = `${floor}/${creator}`;
      perFloorCreator.set(key, (perFloorCreator.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perFloorCreator.values())).toBeLessThanOrEqual(DEFAULT_PLACEMENT_CONFIG.maxPerCreatorPerFloor);
  });

  it('cools down worlds shown in the previous window', () => {
    const repeatRate = (config: typeof DEFAULT_PLACEMENT_CONFIG) => {
      const repository = new MemoryWorldRepository();
      repository.merge(records(40));
      const clock = new RotationClock({ intervalMs: 6 * HOUR, epochMs: Date.UTC(2026, 0, 1) }, () => NOW);
      const service = new PlacementService({ repository, ranking: new RankingService(), signals: NO_SIGNALS, clock, config });
      service.setTowers([{ towerId: 'games', categoryId: 'games', slots: slots(2, 8) }]);
      let repeats = 0;
      let total = 0;
      for (let w = clock.current(); w < clock.current() + 40; w++) {
        const previous = new Set([...service.placement('games', w - 1).values()].map((a) => a.listingId));
        for (const assignment of service.placement('games', w).values()) {
          total++;
          if (previous.has(assignment.listingId)) repeats++;
        }
      }
      return repeats / total;
    };
    const without = repeatRate({ ...DEFAULT_PLACEMENT_CONFIG, cooldownPenalty: 0 });
    const withCooldown = repeatRate(DEFAULT_PLACEMENT_CONFIG);
    expect(withCooldown).toBeLessThan(without * 0.6);
  });

  it('only badges trending worlds that actually have momentum', () => {
    const list = records(10);
    const trendingSlots: PlacementSlot[] = Array.from({ length: 4 }, (_, d) => ({ id: `games:f0:d${d}`, floor: d, band: 'lower', strategy: 'trending', priority: d }));
    const quiet = setup(list, trendingSlots).service.placement('games', 0);
    expect([...quiet.values()].some((a) => a.badge === 'trending')).toBe(false);

    const busy: SignalSource = { signals: (listing) => (listing.id === 'w0003' ? { recent: { enters: 50, visits: 40 } } : {}) };
    const loud = setup(list, trendingSlots, busy).service.placement('games', 0);
    const badged = [...loud.values()].filter((a) => a.badge === 'trending');
    expect(badged.map((a) => a.listingId)).toEqual(['w0003']);
  });

  it('keeps sponsored slots explicit and falls back to an organic pick', () => {
    const list = records(10);
    const repository = new MemoryWorldRepository();
    repository.merge(list);
    const listings = repository.inCategory('games');
    const ranking = new RankingService();
    const scores = new Map(listings.map((l) => [l.id, ranking.score(l, {}, NOW)]));
    const slot: PlacementSlot = { id: 'games:f10:d2', floor: 10, band: 'transfer', strategy: 'sponsored', priority: 0 };
    const organic = placeTower({ towerId: 'games', window: 1, slots: [slot], listings, scores, history: [] }, DEFAULT_PLACEMENT_CONFIG);
    expect(organic.get(slot.id)).toMatchObject({ strategy: 'featured', sponsored: false });
    const paid = placeTower(
      { towerId: 'games', window: 1, slots: [slot], listings, scores, history: [], sponsored: { pick: () => 'w0007' } },
      DEFAULT_PLACEMENT_CONFIG,
    );
    expect(paid.get(slot.id)).toMatchObject({ listingId: 'w0007', sponsored: true, badge: 'sponsored' });
  });

  it('handles thousands of listings quickly', () => {
    const { service, clock } = setup(records(20000), slots(400, 8));
    const started = performance.now();
    const placement = service.placement('games', clock.current());
    expect(placement.size).toBe(3200);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('locates a world for search', () => {
    const { service, clock } = setup(records(3), slots(10, 8));
    const w = clock.current();
    const [first] = service.placement('games', w).values();
    const found = service.locate(first.listingId, w);
    expect(found.some((location) => location.slot.id === first.slotId)).toBe(true);
  });
});

describe('ranking', () => {
  it('buckets counts so small differences do not reorder the city', () => {
    expect(bucket(0)).toBe(0);
    expect(bucket(100)).toBe(bucket(110));
    expect(bucket(100)).toBeLessThan(bucket(1000));
  });

  it('weights recent momentum over lifetime totals', () => {
    const repository = new MemoryWorldRepository();
    repository.merge([
      { id: 'old', name: 'Old', url: 'https://old.test/', addedAt: '2025-06-01T00:00:00Z' },
      { id: 'new', name: 'New', url: 'https://new.test/', addedAt: '2026-09-20T00:00:00Z' },
    ]);
    const [old, fresh] = repository.all();
    const ranking = new RankingService();
    const veteran = ranking.score(old, { views: 50000 }, NOW);
    const hot = ranking.score(fresh, { views: 40, recent: { enters: 200, visits: 150 } }, NOW);
    expect(hot.trending).toBeGreaterThan(veteran.trending);
    expect(veteran.popular).toBeGreaterThan(hot.popular);
  });
});

describe('rotation clock', () => {
  it('counts fixed windows from the epoch', () => {
    let now = Date.UTC(2026, 0, 1) + 6 * HOUR * 10 + 1000;
    const clock = new RotationClock({ intervalMs: 6 * HOUR, epochMs: Date.UTC(2026, 0, 1) }, () => now);
    expect(clock.current()).toBe(10);
    expect(clock.msUntilNext()).toBe(6 * HOUR - 1000);
    now += 6 * HOUR;
    expect(clock.current()).toBe(11);
    clock.skip();
    expect(clock.current()).toBe(12);
  });
});

describe('repository', () => {
  it('keeps listings permanent and adds later sources without reordering', () => {
    const repository = new MemoryWorldRepository();
    repository.merge([{ name: 'Forest', url: 'https://forest.test/', description: 'Pine clearing' }]);
    repository.merge([
      { name: 'Forest again', url: 'https://forest.test' },
      { name: 'Mars', url: 'https://mars.test/', description: 'Low gravity on the red planet' },
    ]);
    expect(repository.all().map((l) => l.name)).toEqual(['Forest', 'Mars']);
    expect(repository.get(repository.all()[1].id)?.categories).toEqual(['space']);
    expect(repository.all()[0].claim).toBe('unclaimed');
  });

  it('finds worlds by name, creator and category', () => {
    const repository = new MemoryWorldRepository();
    repository.merge([
      { name: 'SumbaSurf', url: 'https://surf.test/', creator: '@SumbaSurf', categories: ['games'] },
      { name: 'Space Station', url: 'https://station.test/', creator: 'Elias', categories: ['space'] },
    ]);
    expect(repository.search('surf')[0].listing.name).toBe('SumbaSurf');
    expect(repository.search('elias')[0].field).toBe('creator');
    expect(repository.search('space').map((hit) => hit.listing.name)).toEqual(['Space Station']);
  });

  it('infers a category from the title and description', () => {
    expect(CATEGORIES.infer('Neon racing arcade')).toEqual(['games']);
    expect(CATEGORIES.infer('Something else entirely')).toEqual([CATEGORIES.fallback.id]);
  });
});

import type { WorldListing } from '../worlds/listing';
import type { WorldRepository } from '../worlds/repository';
import { placeTower, type Placement, type PlacementConfig, type PlacementSlot, type SponsoredPlacements } from './placement';
import type { ListingScores, RankingService, SignalSource } from './ranking';
import type { RotationClock } from './rotation';

/** The slots of one tower, as the city laid them out. */
export interface TowerSlots {
  towerId: string;
  categoryId: string;
  slots: readonly PlacementSlot[];
}

export interface PlacedLocation {
  towerId: string;
  slot: PlacementSlot;
}

export interface PlacementServiceDeps {
  repository: WorldRepository;
  ranking: RankingService;
  signals: SignalSource;
  clock: RotationClock;
  config: PlacementConfig;
  sponsored?: SponsoredPlacements;
}

/**
 * Caches placements per tower and window, and answers "where is this world
 * right now?" for search. The rendering side asks this service; it never
 * computes placement itself.
 *
 * Cooldown needs the previous windows' placements, which needed theirs. To
 * stay deterministic whatever order clients ask in, the chain restarts at
 * fixed anchors: windows are grouped in blocks of CHAIN_BLOCK, the first
 * window of a block starts with no history, and every later one is computed
 * from the ones before it in its block. Any client asking for any window
 * computes exactly the same chain.
 */
export class PlacementService {
  private towers = new Map<string, TowerSlots>();
  private placements = new Map<string, Placement>();
  private scoreCache = new Map<string, Map<string, ListingScores>>();

  constructor(private deps: PlacementServiceDeps) {}

  get clock(): RotationClock {
    return this.deps.clock;
  }

  setTowers(towers: readonly TowerSlots[]): void {
    this.towers = new Map(towers.map((tower) => [tower.towerId, tower]));
    this.invalidate();
  }

  /** Listings or signals changed: recompute on next use. */
  invalidate(): void {
    this.placements.clear();
    this.scoreCache.clear();
  }

  placement(towerId: string, window: number): Placement {
    const cached = this.placements.get(`${towerId}@${window}`);
    if (cached) return cached;
    const anchor = window - mod(window, CHAIN_BLOCK);
    const chain: Placement[] = [];
    for (let w = anchor; w <= window; w++) {
      const key = `${towerId}@${w}`;
      let placement = this.placements.get(key);
      if (!placement) {
        const history = chain.slice(-this.deps.config.cooldownWindows).reverse();
        placement = this.compute(towerId, w, history);
        this.placements.set(key, placement);
      }
      chain.push(placement);
    }
    this.trim(this.placements);
    return chain[chain.length - 1];
  }

  /** Every door showing `listingId` in `window`, across all towers. */
  locate(listingId: string, window: number): PlacedLocation[] {
    const found: PlacedLocation[] = [];
    for (const tower of this.towers.values()) {
      const placement = this.placement(tower.towerId, window);
      for (const slot of tower.slots) {
        if (placement.get(slot.id)?.listingId === listingId) found.push({ towerId: tower.towerId, slot });
      }
    }
    return found.sort((a, b) => a.slot.floor - b.slot.floor);
  }

  listing(id: string): WorldListing | undefined {
    return this.deps.repository.get(id);
  }

  private compute(towerId: string, window: number, history: Placement[]): Placement {
    const tower = this.towers.get(towerId);
    if (!tower) return new Map();
    const listings = this.deps.repository.inCategory(tower.categoryId);
    return placeTower(
      {
        towerId,
        window,
        slots: tower.slots,
        listings,
        scores: this.scores(tower.categoryId, listings, window),
        history,
        sponsored: this.deps.sponsored,
      },
      this.deps.config,
    );
  }

  private scores(categoryId: string, listings: readonly WorldListing[], window: number): Map<string, ListingScores> {
    const key = `${categoryId}@${window}`;
    let scores = this.scoreCache.get(key);
    if (!scores) {
      const at = this.deps.clock.startOf(window);
      scores = new Map(listings.map((listing) => [listing.id, this.deps.ranking.score(listing, this.deps.signals.signals(listing), at)]));
      this.scoreCache.set(key, scores);
      this.trim(this.scoreCache);
    }
    return scores;
  }

  private trim<V>(map: Map<string, V>): void {
    // A few blocks of windows per tower is all anyone needs at once.
    while (map.size > 96) map.delete(map.keys().next().value!);
  }
}

/** Windows per cooldown chain. The first window of each block has no cooldown history. */
const CHAIN_BLOCK = 8;

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

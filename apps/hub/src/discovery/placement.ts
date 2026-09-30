import type { WorldListing } from '../worlds/listing';
import { unitHash } from './random';
import type { ListingScores } from './ranking';

/**
 * The door placement engine: decides which listing stands behind which door
 * of one tower for one rotation window.
 *
 * It is a pure function of its inputs (tower, window, slots, listings,
 * scores, recent history), with no DOM, no three.js and no clock, so it can
 * run unchanged in the browser today and in a Worker later, and every
 * visitor who asks for the same window gets the same answer.
 *
 * Placement never changes a listing. A world rotating out of a door stays
 * listed, searchable and reachable by URL; it only stops being on that door.
 */

/** The attention band a floor belongs to. Height has meaning, but every band holds good worlds. */
export type Band = 'lower' | 'middle' | 'transfer' | 'summit' | 'regular';

/** Why a slot wants a listing. Each slot asks for one kind of pick. */
export type Strategy =
  | 'trending'
  | 'popular'
  | 'rising'
  | 'featured'
  | 'fresh'
  | 'gem'
  | 'iconic'
  | 'discovery'
  | 'established'
  | 'wildcard'
  | 'sponsored';

export type Badge = 'new' | 'trending' | 'rising' | 'popular' | 'featured' | 'sponsored';

/** A door position that can hold a listing. */
export interface PlacementSlot {
  /** Stable, e.g. `explore:f12:d3`. */
  id: string;
  floor: number;
  band: Band;
  strategy: Strategy;
  /** Lower fills first. When there are fewer worlds than doors, the low numbers get them. */
  priority: number;
}

export interface Assignment {
  slotId: string;
  listingId: string;
  /** The strategy that actually picked it (a sponsored slot with no sponsor falls back to featured). */
  strategy: Strategy;
  badge: Badge | null;
  sponsored: boolean;
}

/** Slot id → assignment. Slots missing from the map stand empty this window. */
export type Placement = Map<string, Assignment>;

export interface PlacementConfig {
  /** How many previous windows count toward a listing's cooldown. */
  cooldownWindows: number;
  /** Each recent appearance divides a listing's score by (1 + penalty × appearances). */
  cooldownPenalty: number;
  /** A listing appears on at most this many doors of one tower per window (once, while there are more worlds than doors). */
  maxAppearancesPerWindow: number;
  /** At most this many doors per creator on one floor. */
  maxPerCreatorPerFloor: number;
  /** Listings younger than this count as new: NEW badge and an exposure boost. */
  newWorldDays: number;
  newWorldBoost: number;
  /** Each slot picks among this many of the best eligible candidates, so popularity never decides alone. */
  candidatePool: number;
  /** TRENDING / RISING / POPULAR badges go only to the top fraction of the tower's listings. */
  badgeTopFraction: number;
}

export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
  cooldownWindows: 2,
  cooldownPenalty: 4,
  maxAppearancesPerWindow: 2,
  maxPerCreatorPerFloor: 2,
  newWorldDays: 7,
  newWorldBoost: 0.5,
  candidatePool: 5,
  badgeTopFraction: 0.2,
};

/**
 * Paid or promoted placement, kept explicit and separate from organic
 * ranking: only slots whose strategy is `sponsored` ever consult it, and an
 * empty answer falls back to an organic featured pick. Not implemented yet.
 */
export interface SponsoredPlacements {
  /** A listing id booked for this slot and window, or null. */
  pick(towerId: string, slot: PlacementSlot, window: number): string | null;
}

export interface PlacementRequest {
  towerId: string;
  window: number;
  slots: readonly PlacementSlot[];
  /** The tower's listings, in a stable order. */
  listings: readonly WorldListing[];
  scores: ReadonlyMap<string, ListingScores>;
  /** Placements of previous windows, most recent first. */
  history: readonly Placement[];
  sponsored?: SponsoredPlacements;
}

export function placeTower(request: PlacementRequest, config: PlacementConfig): Placement {
  const { towerId, window, scores } = request;
  const placement: Placement = new Map();
  const listings = request.listings.filter((listing) => listing.status === 'listed' && scores.has(listing.id));
  if (!listings.length || !request.slots.length) return placement;
  const byId = new Map(listings.map((listing) => [listing.id, listing]));

  // Cooldown: recent appearances weigh less the longer ago they were.
  const recent = new Map<string, number>();
  request.history.slice(0, config.cooldownWindows).forEach((previous, age) => {
    const weight = 1 / (age + 1);
    for (const assignment of previous.values()) {
      recent.set(assignment.listingId, (recent.get(assignment.listingId) ?? 0) + weight);
    }
  });
  const exposureFactor = (listing: WorldListing) => {
    let factor = 1 / (1 + config.cooldownPenalty * (recent.get(listing.id) ?? 0));
    if (scores.get(listing.id)!.ageDays < config.newWorldDays) factor *= 1 + config.newWorldBoost;
    return factor;
  };
  const factors = new Map(listings.map((listing) => [listing.id, exposureFactor(listing)]));

  // Candidates per strategy, best first. Built on first use.
  const orders = new Map<Strategy, { list: WorldListing[]; start: number }>();
  const orderFor = (strategy: Strategy) => {
    let order = orders.get(strategy);
    if (order) return order;
    const keyed = listings.map((listing) => {
      const tie = unitHash(listing.id, towerId, window, strategy);
      const value = strategy === 'wildcard' ? tie : strategyValue(strategy, listing, scores.get(listing.id)!) * factors.get(listing.id)!;
      return { listing, value, tie };
    });
    keyed.sort((a, b) => b.value - a.value || a.tie - b.tie);
    order = { list: keyed.map((entry) => entry.listing), start: 0 };
    orders.set(strategy, order);
    return order;
  };

  // Badge ranks: position of each listing by the badge's own metric, ignoring cooldown.
  const badgeRanks = new Map<'trending' | 'rising' | 'popular', Map<string, number>>();
  const cutoff = Math.max(1, Math.ceil(listings.length * config.badgeTopFraction));
  const earnsBadge = (metric: 'trending' | 'rising' | 'popular', listing: WorldListing) => {
    if (!(scores.get(listing.id)![metric] > 0)) return false;
    let ranks = badgeRanks.get(metric);
    if (!ranks) {
      const sorted = [...listings].sort((a, b) => scores.get(b.id)![metric] - scores.get(a.id)![metric] || (a.id < b.id ? -1 : 1));
      ranks = new Map(sorted.map((entry, i) => [entry.id, i]));
      badgeRanks.set(metric, ranks);
    }
    return ranks.get(listing.id)! < cutoff;
  };
  const badgeFor = (listing: WorldListing, strategy: Strategy): Badge | null => {
    if (strategy === 'featured' && listing.featured) return 'featured';
    if (strategy === 'trending' && earnsBadge('trending', listing)) return 'trending';
    if (strategy === 'rising' && earnsBadge('rising', listing)) return 'rising';
    if (scores.get(listing.id)!.ageDays < config.newWorldDays) return 'new';
    if ((strategy === 'popular' || strategy === 'iconic' || strategy === 'established') && earnsBadge('popular', listing)) return 'popular';
    return null;
  };

  // Diversity bookkeeping.
  const used = new Map<string, number>();
  const onFloor = new Map<number, Set<string>>();
  const creatorsOnFloor = new Map<number, Map<string, number>>();
  const inBand = new Map<Band, Set<string>>();
  const creatorOf = (listing: WorldListing) => listing.creator.accountId ?? listing.creator.name?.trim().toLowerCase() ?? listing.id;
  // Repeats only when there are fewer worlds than doors.
  const maxAppearances = Math.min(config.maxAppearancesPerWindow, Math.max(1, Math.ceil(request.slots.length / listings.length)));
  const exhausted = (listing: WorldListing) => (used.get(listing.id) ?? 0) >= maxAppearances;
  const eligible = (listing: WorldListing, slot: PlacementSlot) => {
    if (exhausted(listing)) return false;
    if (onFloor.get(slot.floor)?.has(listing.id)) return false;
    if (slot.band !== 'regular' && inBand.get(slot.band)?.has(listing.id)) return false;
    return (creatorsOnFloor.get(slot.floor)?.get(creatorOf(listing)) ?? 0) < config.maxPerCreatorPerFloor;
  };
  const take = (slot: PlacementSlot, listing: WorldListing, strategy: Strategy, sponsored: boolean) => {
    placement.set(slot.id, {
      slotId: slot.id,
      listingId: listing.id,
      strategy,
      badge: sponsored ? 'sponsored' : badgeFor(listing, strategy),
      sponsored,
    });
    used.set(listing.id, (used.get(listing.id) ?? 0) + 1);
    setOf(onFloor, slot.floor).add(listing.id);
    if (slot.band !== 'regular') setOf(inBand, slot.band).add(listing.id);
    let creators = creatorsOnFloor.get(slot.floor);
    if (!creators) creatorsOnFloor.set(slot.floor, (creators = new Map()));
    const creator = creatorOf(listing);
    creators.set(creator, (creators.get(creator) ?? 0) + 1);
  };

  const slots = [...request.slots].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const slot of slots) {
    let strategy = slot.strategy;
    if (strategy === 'sponsored') {
      const booked = request.sponsored?.pick(towerId, slot, window);
      const listing = booked ? byId.get(booked) : undefined;
      if (listing && eligible(listing, slot)) {
        take(slot, listing, 'sponsored', true);
        continue;
      }
      strategy = 'featured';
    }

    const order = orderFor(strategy);
    // Listings used up for this window never come back: skip past them for good.
    while (order.start < order.list.length && exhausted(order.list[order.start])) order.start++;
    const candidates: WorldListing[] = [];
    for (let i = order.start; i < order.list.length && candidates.length < config.candidatePool; i++) {
      if (eligible(order.list[i], slot)) candidates.push(order.list[i]);
    }
    if (!candidates.length) continue;

    // Weighted toward the best, but never always the best.
    let total = 0;
    const weights = candidates.map((_, i) => (total += Math.pow(0.55, i)));
    const roll = unitHash(towerId, window, slot.id, 'pick') * total;
    const index = weights.findIndex((weight) => roll < weight);
    take(slot, candidates[index < 0 ? candidates.length - 1 : index], strategy, false);
  }
  return placement;
}

function strategyValue(strategy: Strategy, listing: WorldListing, s: ListingScores): number {
  switch (strategy) {
    case 'trending':
      return s.trending;
    case 'popular':
    case 'established':
      return s.popular;
    case 'rising':
      return s.rising;
    case 'featured':
      return (listing.featured ? 2 : 0) + s.quality + s.rising * 0.5;
    case 'fresh':
      return s.fresh;
    case 'gem':
      return s.gem;
    case 'iconic':
      return s.popular + s.quality;
    case 'discovery':
      // The least seen first, whatever their age: this is where unknown
      // creators get found. Equal exposure falls to the per-window shuffle.
      return 1 / (1 + s.exposure);
    case 'wildcard':
    case 'sponsored':
      return 0;
  }
}

function setOf<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}

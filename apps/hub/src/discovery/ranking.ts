import type { WorldListing } from '../worlds/listing';

/**
 * Ranking: turns what is known about a listing into a handful of scores the
 * placement engine picks from. Deliberately simple and replaceable; the
 * formula is expected to change, the shape of its output should not.
 *
 * Trending is about recent momentum, not lifetime totals. A world can be
 * trending without ever moving its listing: placement just references it
 * from a Trending door for a while.
 */

/** Counts over the recent window (the last day, say). All optional. */
export interface RecentSignals {
  impressions: number;
  previewWatches: number;
  approaches: number;
  enters: number;
  visits: number;
  repeatVisits: number;
  saves: number;
}

export interface ListingSignals {
  /** Lifetime visits (the hub's existing view counter). */
  views?: number;
  recent?: Partial<RecentSignals>;
}

/**
 * Supplies signals for a listing. Must return the same numbers to every
 * client for the same rotation window, or visitors see different cities.
 * Today that holds only roughly (lifetime views, bucketed); production should
 * serve a per-window snapshot computed server-side.
 */
export interface SignalSource {
  signals(listing: WorldListing): ListingSignals;
}

export const NO_SIGNALS: SignalSource = { signals: () => ({}) };

export interface ListingScores {
  /** Recent momentum. */
  trending: number;
  /** Momentum weighted toward young listings. */
  rising: number;
  /** Lifetime reach. */
  popular: number;
  /** How well it converts attention into visits. */
  quality: number;
  /** Good but under-exposed. */
  gem: number;
  /** 1 when brand new, halving every `freshHalfLifeDays`. */
  fresh: number;
  /** How much attention it has had already. */
  exposure: number;
  ageDays: number;
}

export interface RankingWeights {
  recent: RecentSignals;
  freshHalfLifeDays: number;
  /** Momentum doubles for listings younger than this many days. */
  risingAgeDays: number;
  /** Claimed listings get this much extra quality (verified creators keep them current). */
  claimedBoost: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recent: { impressions: 0.02, previewWatches: 0.3, approaches: 0.5, enters: 3, visits: 2, repeatVisits: 2.5, saves: 4 },
  freshHalfLifeDays: 10,
  risingAgeDays: 21,
  claimedBoost: 0.1,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export class RankingService {
  constructor(private weights: RankingWeights = DEFAULT_RANKING_WEIGHTS) {}

  /** Scores for one listing as of `at` (a rotation window's start, not the wall clock). */
  score(listing: WorldListing, signals: ListingSignals, at: number): ListingScores {
    const w = this.weights;
    const ageDays = Math.max(0.5, (at - listing.listedAt) / DAY_MS);
    // Bucketed, so small differences between two clients' fetches do not
    // reorder the city.
    const views = bucket(signals.views ?? 0);
    const recent = signals.recent ?? {};
    let momentum = 0;
    for (const key of Object.keys(w.recent) as (keyof RecentSignals)[]) momentum += bucket(recent[key] ?? 0) * w.recent[key];

    // Without recent counts yet, lifetime views per day stand in for momentum
    // (what the list page ranks by), decaying with age.
    const trending = momentum > 0 ? Math.log1p(momentum) : Math.log1p(views / ageDays) * Math.exp(-ageDays / 60);
    const fresh = Math.pow(0.5, ageDays / w.freshHalfLifeDays);
    const rising = trending * (1 + Math.exp(-ageDays / w.risingAgeDays)) + fresh * 0.25;
    const popular = Math.log1p(views);
    const impressions = bucket(recent.impressions ?? 0);
    const enters = bucket(recent.enters ?? 0) + bucket(recent.visits ?? 0);
    const conversion = impressions > 0 ? Math.min(1, enters / impressions) : 0.5;
    const quality = conversion + (listing.claim === 'claimed' ? w.claimedBoost : 0) + (listing.featured ? 0.25 : 0);
    const exposure = Math.log1p(views + impressions);
    const gem = quality / (1 + exposure);
    return { trending, rising, popular, quality, gem, fresh, exposure, ageDays };
  }
}

/** Round to half-steps on a log2 scale: 0, 1, 1.4, 2, 2.8, 4, 5.7, 8, ... */
export function bucket(value: number): number {
  if (!(value > 0)) return 0;
  return Math.pow(2, Math.floor(Math.log2(value) * 2) / 2);
}

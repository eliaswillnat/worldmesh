import { CATEGORIES, type CategoryRegistry } from './categories';
import { canonicalUrl, normalizeListing, type WorldListing, type WorldRecordInput } from './listing';

/**
 * Where the city reads listings from. The city never talks to a database or
 * an API itself; it asks a repository. Today the hub feeds the repository
 * the same records its list page shows (community.json, /api/worlds and the
 * demos). Once the directory moves into D1 an API-backed repository can
 * implement the same interface without touching the city.
 */
export interface WorldRepository {
  /** Bumps whenever the listings change. */
  readonly version: number;
  all(): readonly WorldListing[];
  get(id: string): WorldListing | undefined;
  /** Listed worlds in a category, in a stable order (by id). */
  inCategory(categoryId: string): readonly WorldListing[];
  search(query: string, limit?: number): SearchHit[];
  subscribe(listener: () => void): () => void;
}

export interface SearchHit {
  listing: WorldListing;
  score: number;
  /** What matched: shown next to the result. */
  field: 'name' | 'creator' | 'category' | 'tag' | 'description' | 'url';
}

/** Records given to the city before they have an addedAt date sort as this old. */
const FALLBACK_LISTED_AT = Date.parse('2026-09-27T21:03:21Z');

export class MemoryWorldRepository implements WorldRepository {
  version = 0;
  private listings: WorldListing[] = [];
  private byId = new Map<string, WorldListing>();
  private byCategory = new Map<string, WorldListing[]>();
  private listeners = new Set<() => void>();

  constructor(private categories: CategoryRegistry = CATEGORIES) {}

  /**
   * Add records, keeping the ones already known (matched by URL). Records
   * arriving later never replace or reorder earlier ones, so a second
   * source (e.g. /api/worlds after community.json) only adds.
   */
  merge(records: readonly WorldRecordInput[]): void {
    const known = new Set(this.listings.map((listing) => canonicalUrl(listing.url)));
    let changed = false;
    for (const record of records) {
      if (!record?.url || !record.name) continue;
      const key = canonicalUrl(record.url);
      if (known.has(key)) continue;
      known.add(key);
      const listing = normalizeListing(record, this.categories, FALLBACK_LISTED_AT);
      if (this.byId.has(listing.id)) continue;
      this.listings.push(listing);
      this.byId.set(listing.id, listing);
      changed = true;
    }
    if (changed) this.reindex();
  }

  /** Replace everything, e.g. with a synthetic set while debugging. */
  replace(records: readonly WorldRecordInput[]): void {
    this.listings = [];
    this.byId.clear();
    this.merge(records);
    this.reindex();
  }

  all(): readonly WorldListing[] {
    return this.listings;
  }

  get(id: string): WorldListing | undefined {
    return this.byId.get(id);
  }

  inCategory(categoryId: string): readonly WorldListing[] {
    return this.byCategory.get(categoryId) ?? [];
  }

  search(query: string, limit = 12): SearchHit[] {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const listing of this.listings) {
      if (listing.status !== 'listed') continue;
      const fields: [SearchHit['field'], string, number][] = [
        ['name', listing.name, 5],
        ['creator', listing.creator.name ?? '', 3],
        ['category', listing.categories.map((id) => this.categories.get(id)?.name ?? id).join(' '), 2],
        ['tag', listing.tags.join(' '), 2],
        ['description', listing.description ?? '', 1],
        ['url', listing.url, 1],
      ];
      let score = 0;
      let best: SearchHit['field'] = 'name';
      let bestScore = 0;
      let all = true;
      for (const term of terms) {
        let termScore = 0;
        for (const [field, text, weight] of fields) {
          const lower = text.toLowerCase();
          const at = lower.indexOf(term);
          if (at < 0) continue;
          // Word starts count more than matches inside a word.
          const value = weight * (at === 0 || /\W/.test(lower[at - 1]) ? 1.5 : 1);
          if (value > termScore) termScore = value;
          if (value > bestScore) {
            bestScore = value;
            best = field;
          }
        }
        if (!termScore) all = false;
        score += termScore;
      }
      if (all && score > 0) hits.push({ listing, score, field: best });
    }
    return hits.sort((a, b) => b.score - a.score || a.listing.name.localeCompare(b.listing.name)).slice(0, limit);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reindex(): void {
    this.byCategory.clear();
    const sorted = [...this.listings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const listing of sorted) {
      if (listing.status !== 'listed') continue;
      for (const category of listing.categories) {
        let list = this.byCategory.get(category);
        if (!list) this.byCategory.set(category, (list = []));
        list.push(listing);
      }
    }
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

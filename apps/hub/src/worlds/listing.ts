import { hashString } from '../discovery/random';
import type { CategoryRegistry } from './categories';

/**
 * A world listed in WorldMesh: the permanent record, one per world. Where a
 * world currently stands in the city (its door) is a separate, temporary
 * thing computed by ../discovery: a listing never moves, disappears or gets
 * duplicated because it rotated out of a door.
 *
 * The same shape serves every source: worlds added by hand, submitted by
 * creators, found by WorldMesh, and the demo worlds. None of them needs an
 * account behind it.
 */
export interface WorldListing {
  /** Stable id. The directory id when there is one, otherwise derived from the URL. */
  id: string;
  url: string;
  name: string;
  description?: string;
  /** Still image, any aspect; doors crop it to 9:16. */
  cover?: string;
  /** Short muted loops for the door, best first (WebM before MP4). */
  preview?: PreviewMedia[];
  color?: string;
  creator: CreatorRef;
  /** Category ids. The first is the listing's home tower. */
  categories: string[];
  tags: string[];
  source: ListingSource;
  claim: ClaimStatus;
  /** Editorial pick: eligible for featured slots. */
  featured: boolean;
  status: 'listed' | 'removed';
  /** When it was listed, unix ms. */
  listedAt: number;
}

export interface PreviewMedia {
  src: string;
  /** MIME type, e.g. video/webm. Guessed from the extension when missing. */
  type?: string;
}

export interface CreatorRef {
  name?: string;
  /** Portfolio or social link. */
  url?: string;
  /** WorldMesh account that claimed the listing, once one has. */
  accountId?: string;
}

/** How a listing got here. */
export type ListingSource = 'admin' | 'submitted' | 'demo' | 'discovered';

/** Unclaimed listings were added by someone other than their creator. */
export type ClaimStatus = 'unclaimed' | 'claimed';

/**
 * A world record as the hub has it today (community.json, /api/worlds, the
 * demo list), plus the optional fields the city understands. Everything
 * beyond name and url is optional, so older records keep working.
 */
export interface WorldRecordInput {
  id?: string;
  name: string;
  url: string;
  description?: string;
  cover?: string;
  color?: string;
  creator?: string;
  portfolio?: string;
  addedAt?: string;
  approvedAt?: string;
  submittedAt?: string;
  categories?: string[];
  category?: string;
  tags?: string[];
  preview?: string | string[];
  featured?: boolean;
  source?: ListingSource;
  /** Account id of the creator who claimed it. */
  ownerId?: string;
  status?: 'listed' | 'removed';
}

/** A stable id for a record: its own id, or one derived from its URL. */
export function listingId(record: Pick<WorldRecordInput, 'id' | 'url'>): string {
  if (record.id) return record.id;
  return `u-${hashString(canonicalUrl(record.url)).toString(36)}`;
}

/** URL without trailing slash, hash or case differences in the host. */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

export function normalizeListing(record: WorldRecordInput, categories: CategoryRegistry, fallbackListedAt: number): WorldListing {
  const named = [...(record.categories ?? []), ...(record.category ? [record.category] : [])].filter((id) => categories.has(id));
  const listed = Date.parse(record.addedAt ?? record.approvedAt ?? record.submittedAt ?? '');
  return {
    id: listingId(record),
    url: record.url,
    name: record.name,
    description: record.description,
    cover: record.cover,
    preview: normalizePreview(record.preview),
    color: record.color,
    creator: { name: record.creator || undefined, url: record.portfolio || undefined, accountId: record.ownerId },
    categories: named.length ? unique(named) : categories.infer(`${record.name} ${record.description ?? ''}`),
    tags: unique((record.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
    source: record.source ?? (record.submittedAt ? 'submitted' : 'admin'),
    claim: record.ownerId ? 'claimed' : 'unclaimed',
    featured: record.featured === true,
    status: record.status ?? 'listed',
    listedAt: Number.isFinite(listed) ? listed : fallbackListedAt,
  };
}

function normalizePreview(preview: string | string[] | undefined): PreviewMedia[] | undefined {
  const sources = (Array.isArray(preview) ? preview : preview ? [preview] : []).filter((src) => /^(https?:\/\/|\/|blob:)/.test(src));
  if (!sources.length) return undefined;
  return sources.map((src) => ({ src, type: guessVideoType(src) }));
}

function guessVideoType(src: string): string | undefined {
  const path = src.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'video/mp4';
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

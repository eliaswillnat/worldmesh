import { CanvasTexture, Color, LinearFilter, SRGBColorSpace, type Texture } from 'three';
import type { Badge } from '../discovery/placement';
import type { WorldListing } from '../worlds/listing';
import { SIGN_FONT } from './signage';

/**
 * What a door shows for one world: a 9:16 poster cut from the world's cover
 * and a caption (title, creator). Cached per world, not per door, so a world
 * on two doors costs one set of textures, and reference counted so the cache
 * can drop worlds nobody is looking at.
 */
export interface WorldCard {
  readonly listingId: string;
  /** Null until the cover has loaded, or for good if it cannot be read. */
  poster: Texture | null;
  caption: Texture;
  /** Resolves once the poster has loaded or failed; either way the door can open. */
  readonly ready: Promise<void>;
  loaded: boolean;
  disposed: boolean;
}

/** Poster resolution: small, since a door is a few metres tall and rarely fills the screen. */
const POSTER_W = 270;
const POSTER_H = 480;
/** Caption canvas; the door shader maps it onto the bottom of the door. */
export const CAPTION_W = 512;
export const CAPTION_H = 200;

interface Entry {
  card: WorldCard;
  refs: number;
  lastUsed: number;
}

export class CardCache {
  private entries = new Map<string, Entry>();

  constructor(private max: number) {}

  get size(): number {
    return this.entries.size;
  }

  acquire(listing: WorldListing): WorldCard {
    let entry = this.entries.get(listing.id);
    if (!entry) {
      entry = { card: createCard(listing), refs: 0, lastUsed: 0 };
      this.entries.set(listing.id, entry);
    }
    entry.refs++;
    entry.lastUsed = performance.now();
    this.evict();
    return entry.card;
  }

  release(listingId: string): void {
    const entry = this.entries.get(listingId);
    if (entry) {
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastUsed = performance.now();
    }
    this.evict();
  }

  dispose(): void {
    for (const entry of this.entries.values()) disposeCard(entry.card);
    this.entries.clear();
  }

  private evict(): void {
    if (this.entries.size <= this.max) return;
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, entry] of idle) {
      if (this.entries.size <= this.max) break;
      disposeCard(entry.card);
      this.entries.delete(id);
    }
  }
}

function disposeCard(card: WorldCard): void {
  card.disposed = true;
  card.poster?.dispose();
  card.caption.dispose();
}

function createCard(listing: WorldListing): WorldCard {
  const card: WorldCard = {
    listingId: listing.id,
    poster: null,
    caption: drawCaption(listing),
    loaded: false,
    disposed: false,
    ready: Promise.resolve(),
  };
  (card as { ready: Promise<void> }).ready = loadPoster(listing).then(
    (poster) => {
      // Evicted while loading: nobody will ever dispose it otherwise.
      if (card.disposed) poster?.dispose();
      else card.poster = poster;
      card.loaded = true;
    },
    () => {
      card.loaded = true;
    },
  );
  return card;
}

function drawCaption(listing: WorldListing): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CAPTION_W;
  canvas.height = CAPTION_H;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, CAPTION_W, CAPTION_H);
    // A flat scrim, no gradient: the caption reads over any poster.
    ctx.fillStyle = 'rgba(12, 13, 16, 0.78)';
    ctx.fillRect(0, 0, CAPTION_W, CAPTION_H);
    const pad = 30;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    let size = 60;
    ctx.font = `700 ${size}px ${SIGN_FONT}`;
    const title = listing.name;
    while (ctx.measureText(title).width > CAPTION_W - pad * 2 && size > 34) {
      size -= 2;
      ctx.font = `700 ${size}px ${SIGN_FONT}`;
    }
    ctx.fillText(fit(ctx, title, CAPTION_W - pad * 2), pad, 96);
    if (listing.creator.name) {
      ctx.font = `500 34px ${SIGN_FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.fillText(fit(ctx, `by ${listing.creator.name}`, CAPTION_W - pad * 2), pad, 150);
    }
    texture.needsUpdate = true;
  };
  draw();
  if (document.fonts && !document.fonts.check(`700 60px Urbanist`)) document.fonts.load('700 60px Urbanist').then(draw, () => {});
  return texture;
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

async function loadPoster(listing: WorldListing): Promise<Texture | null> {
  if (!listing.cover) return null;
  const image = await loadImage(listing.cover);
  if (!image) return null;
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext('2d')!;
  // Cover-crop to 9:16, keeping the centre.
  const scale = Math.max(POSTER_W / image.width, POSTER_H / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, (POSTER_W - w) / 2, (POSTER_H - h) / 2, w, h);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * Covers live on other hosts, and WebGL needs CORS to read them: try the
 * hub's same-origin cover proxy first, then the image directly.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  const candidates: string[] = [];
  try {
    const url = new URL(src, window.location.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== window.location.origin) {
      candidates.push(`/api/cover?url=${encodeURIComponent(url.toString())}`);
    }
    candidates.push(url.toString());
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const next = () => {
      const candidate = candidates.shift();
      if (!candidate) return resolve(null);
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = next;
      image.src = candidate;
    };
    next();
  });
}

// ── Shared atlases ───────────────────────────────────────────────────────────

export const BADGE_ROWS: Badge[] = ['new', 'trending', 'rising', 'popular', 'featured', 'sponsored'];
const BADGE_STYLE: Record<Badge, { label: string; fill: string; ink: string }> = {
  new: { label: 'NEW', fill: '#ffffff', ink: '#111111' },
  trending: { label: 'TRENDING', fill: '#ff6b3d', ink: '#ffffff' },
  rising: { label: 'RISING', fill: '#5fd1a4', ink: '#0b1a14' },
  popular: { label: 'POPULAR', fill: '#f2c14e', ink: '#1a1405' },
  featured: { label: 'FEATURED', fill: '#9aa6ff', ink: '#0d1030' },
  sponsored: { label: 'SPONSORED', fill: '#d8d8d8', ink: '#222222' },
};
/** Badge pill size in the atlas; the shader uses the same aspect. */
export const BADGE_W = 256;
export const BADGE_H = 64;

/** One row per badge, flat pills. */
export function createBadgeAtlas(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_W;
  canvas.height = BADGE_H * BADGE_ROWS.length;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    BADGE_ROWS.forEach((badge, row) => {
      const style = BADGE_STYLE[badge];
      // Rows count from the top of the canvas; the shader flips.
      const y = row * BADGE_H;
      ctx.font = `800 34px ${SIGN_FONT}`;
      const width = Math.min(BADGE_W - 8, ctx.measureText(style.label).width + 40);
      ctx.fillStyle = style.fill;
      roundRect(ctx, 4, y + 8, width, BADGE_H - 16, (BADGE_H - 16) / 2);
      ctx.fill();
      ctx.fillStyle = style.ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(style.label, 24, y + BADGE_H / 2 + 1);
    });
    texture.needsUpdate = true;
  };
  draw();
  if (document.fonts && !document.fonts.check(`800 34px Urbanist`)) document.fonts.load('800 34px Urbanist').then(draw, () => {});
  return texture;
}

export const STATUS_ROWS = ['REASSIGNING', 'OPEN SLOT'] as const;
export const STATUS_W = 512;
export const STATUS_H = 96;

/** Words shown on a closed shutter. */
export function createStatusAtlas(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = STATUS_W;
  canvas.height = STATUS_H * STATUS_ROWS.length;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 40px ${SIGN_FONT}`;
    ctx.fillStyle = '#ffffff';
    STATUS_ROWS.forEach((label, row) => ctx.fillText(label.split('').join(' '), STATUS_W / 2, row * STATUS_H + STATUS_H / 2));
    texture.needsUpdate = true;
  };
  draw();
  if (document.fonts && !document.fonts.check(`600 40px Urbanist`)) document.fonts.load('600 40px Urbanist').then(draw, () => {});
  return texture;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The world's own colour, or its category's, for doors without a poster. */
export function tintFor(listing: WorldListing | null, fallback: string): Color {
  const color = new Color(listing?.color ?? fallback);
  return color.lerp(new Color(0xffffff), 0.2);
}

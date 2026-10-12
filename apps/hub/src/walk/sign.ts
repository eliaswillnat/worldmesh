import { CanvasTexture, Color, LinearFilter, SRGBColorSpace } from 'three';
import { drawEntries, measureEntries } from '../entries';

/**
 * A storefront's fascia sign: the world's logo and name over its door in the
 * city, like a shop's. Dark with amber gate numbers in either theme, like the
 * avenue signs in the exits and the departures board, so the storefronts read as one
 * street however different the worlds behind them are.
 */

/** Canvas height; the width follows the sign's own shape. */
const SIGN_PX = 256;
const MAX_WIDTH_PX = 2048;
const FAMILY = 'Urbanist, ui-sans-serif, system-ui, sans-serif';
const PLATE = '#0d0d10';
const AMBER = '#ffc23d';

export interface SignContent {
  name: string;
  creator?: string;
  /** No world here yet: a quiet sign inviting someone to claim the door, with a "+" for its logo. */
  empty?: boolean;
  /** Shown instead of the creator. */
  subtitle?: string;
  /** What the world offers ("Multiplayer", "VR supported"), as on the door's chips. */
  features: string[];
  entries(): number | undefined;
  gate(): number | null;
  /** The world's colour, for the logo when there is no cover yet. */
  tint(): Color;
  /** The world's cover, once loaded: its middle becomes the logo. */
  cover(): CanvasImageSource | null;
}

/** A rounded square path, `r` the corner radius. */
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, r);
}

/** The text cut to fit `width` pixels, with an ellipsis if anything was cut. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The logo tile: the middle of the cover as an app-style icon, or the world's initial on its colour. */
function drawLogo(ctx: CanvasRenderingContext2D, content: SignContent, x: number, y: number, size: number): void {
  const radius = size * 0.22;
  const cover = content.cover() as (CanvasImageSource & { width: number; height: number }) | null;
  ctx.save();
  rounded(ctx, x, y, size, radius);
  ctx.clip();
  if (content.empty) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    const bar = size * 0.08;
    ctx.fillRect(x + size * 0.3, y + (size - bar) / 2, size * 0.4, bar);
    ctx.fillRect(x + (size - bar) / 2, y + size * 0.3, bar, size * 0.4);
  } else if (cover && cover.width && cover.height) {
    const side = Math.min(cover.width, cover.height);
    ctx.drawImage(cover, (cover.width - side) / 2, (cover.height - side) / 2, side, side, x, y, size, size);
  } else {
    ctx.fillStyle = `#${content.tint().getHexString()}`;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(size * 0.56)}px ${FAMILY}`;
    const initial = [...content.name.trim()][0]?.toUpperCase() ?? '?';
    ctx.fillText(initial, x + size / 2, y + size / 2 + size * 0.04);
  }
  ctx.restore();
  // A hairline round the tile, so a dark cover still reads against the plate.
  rounded(ctx, x + 1, y + 1, size - 2, radius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** "GATE" over the number, right-aligned at `right`; returns the width it took. */
function drawGate(ctx: CanvasRenderingContext2D, gate: number, right: number, middle: number): number {
  const number = String(gate).padStart(2, '0');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = AMBER;
  ctx.font = `700 96px ${FAMILY}`;
  const width = ctx.measureText(number).width;
  ctx.fillText(number, right, middle + 56);
  ctx.font = `700 34px ${FAMILY}`;
  ctx.textAlign = 'center';
  ctx.fillText('GATE', right - width / 2, middle - 46);
  return Math.max(width, ctx.measureText('GATE').width);
}

/**
 * The sign's texture for a sign `aspect` times as wide as it is tall, and a
 * draw() that repaints it: call it again whenever the cover, entries or gate
 * number change.
 */
export function createSign(content: SignContent, aspect: number): { texture: CanvasTexture; draw: () => void } {
  const canvas = document.createElement('canvas');
  canvas.height = SIGN_PX;
  canvas.width = Math.min(MAX_WIDTH_PX, Math.round(SIGN_PX * aspect));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;

  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const pad = Math.round(h * 0.14);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PLATE;
    ctx.fillRect(0, 0, w, h);
    // A slim rule of the world's own colour along the bottom.
    if (!content.empty) {
      ctx.fillStyle = `#${content.tint().getHexString()}`;
      ctx.fillRect(0, h - Math.round(h * 0.035), w, Math.round(h * 0.035));
    }

    const logo = h - pad * 2;
    drawLogo(ctx, content, pad, pad, logo);
    const gate = content.gate();
    const gateWidth = gate === null ? 0 : drawGate(ctx, gate, w - pad, h / 2) + pad;
    const left = pad * 2 + logo;
    const room = w - left - pad - gateWidth;

    // The name as large as fits, down to a floor; past that it is cut short.
    let size = Math.round(h * 0.38);
    ctx.font = `600 ${size}px ${FAMILY}`;
    while (size > h * 0.24 && ctx.measureText(content.name).width > room) {
      size -= 4;
      ctx.font = `600 ${size}px ${FAMILY}`;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = content.empty ? 'rgba(255, 255, 255, 0.6)' : '#ffffff';
    ctx.fillText(fit(ctx, content.name, room), left, h * 0.54);

    // Creator, entries and what the world offers, on one quieter line.
    const quiet = 'rgba(255, 255, 255, 0.6)';
    ctx.font = `500 ${Math.round(h * 0.15)}px ${FAMILY}`;
    ctx.fillStyle = quiet;
    const baseline = h * 0.8;
    let x = left;
    const gap = Math.round(h * 0.09);
    const words = [content.subtitle ?? (content.creator ? `by ${content.creator}` : ''), ...content.features].filter(Boolean);
    const count = content.entries();
    const iconSize = Math.round(h * 0.13);
    const entriesWidth = count === undefined ? 0 : measureEntries(ctx, count, iconSize, 10);
    if (words[0]) {
      const text = fit(ctx, words[0], room - (entriesWidth ? entriesWidth + gap : 0));
      ctx.fillText(text, x, baseline);
      x += ctx.measureText(text).width + gap;
    }
    if (count !== undefined && x + entriesWidth <= left + room) {
      drawEntries(ctx, count, x, baseline, iconSize, 10, quiet);
      x += entriesWidth + gap;
    }
    for (const word of words.slice(1)) {
      const width = ctx.measureText(word).width;
      if (x + width > left + room) break;
      ctx.fillStyle = quiet;
      ctx.fillText(word, x, baseline);
      x += width + gap;
    }
    texture.needsUpdate = true;
  };

  // The page font may still be loading.
  if (document.fonts && !document.fonts.check(`600 88px ${FAMILY}`)) {
    document.fonts.load(`600 88px ${FAMILY}`).then(draw, () => {});
  }
  return { texture, draw };
}

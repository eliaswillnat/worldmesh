/**
 * Entries: how many times people went into a world (the views counter in
 * workers/views, deduped per visitor for 30 minutes). Shown next to doors in
 * the 3D city and on gallery cards, always with the same icon.
 *
 * The icon is Lucide's square-arrow-right-enter (ISC licence,
 * https://lucide.dev), kept here as raw paths so canvas labels can draw it
 * without pulling in an icon library.
 */

/** square-arrow-right-enter, on Lucide's 24×24 grid, stroked at width 2. */
const ICON_PATHS = ['m10 16 4-4-4-4', 'M3 12h11', 'M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3'];

/** The icon as inline SVG, coloured by the surrounding text. */
export function entryIconSvg(size = 12): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS.map((d) => `<path d="${d}"/>`).join('')}</svg>`
  );
}

let paths: Path2D[] | null = null;

/** Draw the icon into a canvas, `size` pixels square with its top left at (x, y). */
export function drawEntryIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  paths ??= ICON_PATHS.map((d) => new Path2D(d));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of paths) ctx.stroke(path);
  ctx.restore();
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** 7, 1.2K, 34K, 1.5M. */
export function formatEntries(count: number): string {
  return compact.format(count);
}

/** Only worlds someone has actually entered get a count. */
export function hasEntries(count: number | undefined): count is number {
  return typeof count === 'number' && Number.isFinite(count) && count > 0;
}

/**
 * Width of an icon-and-count run at the given font, for laying it out beside
 * other text. The icon is as tall as the font's cap height, roughly.
 */
export function measureEntries(ctx: CanvasRenderingContext2D, count: number, iconSize: number, gap: number): number {
  return iconSize + gap + ctx.measureText(formatEntries(count)).width;
}

/**
 * Draw icon then count, left aligned at x, on the text baseline `baseline`.
 * Uses the context's current font. Returns the width drawn.
 */
export function drawEntries(
  ctx: CanvasRenderingContext2D,
  count: number,
  x: number,
  baseline: number,
  iconSize: number,
  gap: number,
  color: string,
): number {
  const text = formatEntries(count);
  const metrics = ctx.measureText(text);
  // Centre the icon on the digits: they sit on the baseline, cap height tall.
  const capHeight = metrics.actualBoundingBoxAscent || iconSize * 0.75;
  drawEntryIcon(ctx, x, baseline - capHeight / 2 - iconSize / 2, iconSize, color);
  ctx.fillStyle = color;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + iconSize + gap, baseline);
  ctx.textAlign = align;
  return iconSize + gap + metrics.width;
}

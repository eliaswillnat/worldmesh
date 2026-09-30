import { CanvasTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Canvas lettering for the city: floor bands, tower names, bridge signs,
 * door captions. Flat colours only.
 */

export const SIGN_FONT = 'Urbanist, "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif';

export interface TextRun {
  text: string;
  color: string;
  /** Font weight and size in canvas pixels. */
  font: string;
}

/**
 * One line of runs laid out left to right, centred in a canvas of the given
 * size, optionally repeated `repeat` times across (for bands wrapped around
 * a cylinder).
 */
export function drawBand(
  runs: TextRun[],
  options: { width: number; height: number; repeat?: number; background?: string | null; gap?: number; mirror?: boolean },
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const repeat = options.repeat ?? 1;
    const cell = canvas.width / repeat;
    const gap = options.gap ?? 24;
    ctx.save();
    if (options.mirror) {
      // Seen from inside a cylinder, text reads mirrored unless drawn flipped.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.textBaseline = 'middle';
    for (let i = 0; i < repeat; i++) {
      let total = 0;
      for (const run of runs) {
        ctx.font = run.font;
        total += ctx.measureText(run.text).width + gap;
      }
      total -= gap;
      let x = cell * i + (cell - total) / 2;
      for (const run of runs) {
        ctx.font = run.font;
        ctx.fillStyle = run.color;
        ctx.fillText(run.text, x, canvas.height / 2 + 2);
        x += ctx.measureText(run.text).width + gap;
      }
    }
    ctx.restore();
    texture.needsUpdate = true;
  };
  draw();
  // The page font may still be loading.
  if (document.fonts && !document.fonts.check(`700 40px Urbanist`)) {
    document.fonts.load('700 40px Urbanist').then(draw, () => {});
  }
  texture.wrapS = RepeatWrapping;
  return texture;
}

/** A category name, e.g. "EXPLORE", tracked out. */
export function spaced(text: string): string {
  return text.toUpperCase().split('').join(' ');
}

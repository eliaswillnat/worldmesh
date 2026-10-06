import type { Object3D } from 'three';

/** Seconds before the figure starts to show, and how long its warp and fade-in take. */
const DELAY = 0.2;
const DURATION = 0.12;
/** Longest step per frame, so a loading hitch slows the arrival rather than skipping it. */
const MAX_STEP = 1 / 30;

/**
 * The clock for a figure arriving: how far its appear warp has run. Works for
 * any figure, the default one or a loaded avatar, and starts over when the
 * figure changes (an avatar that finished loading).
 */
export class Arrival {
  private target: (() => Object3D | null) | null = null;
  private current: Object3D | null = null;
  private time = 0;

  /** Arrive as whatever figure `figure` returns (it may still be loading: it is asked again each frame). */
  start(figure: () => Object3D | null): void {
    this.target = figure;
    this.current = null;
    this.time = 0;
  }

  /** Advance one frame. Returns how far the figure has appeared (0–1) while arriving, or null once done. */
  update(dt: number): number | null {
    if (!this.target) return null;
    const root = this.target();
    if (!root) return 0;
    if (root !== this.current) {
      this.current = root;
      this.time = 0;
    }
    this.time += Math.min(Math.max(dt, 0), MAX_STEP);
    const t = Math.min(1, Math.max(0, (this.time - DELAY) / DURATION));
    if (t >= 1) {
      this.target = null;
      return 1;
    }
    return t * t * (3 - 2 * t);
  }
}

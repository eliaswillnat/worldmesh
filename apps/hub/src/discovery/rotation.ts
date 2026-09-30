/**
 * Rotation windows. Door assignments are fixed for one window (six hours by
 * default) and computed from the window's index, so everyone who loads the
 * city during the same window sees the same doors, whatever their clock or
 * local state. The window index is the only notion of time placement uses.
 */
export interface RotationSettings {
  /** Length of one window in ms. */
  intervalMs: number;
  /** Windows are counted from here (unix ms). Changing it reshuffles the city. */
  epochMs: number;
}

export class RotationClock {
  /** Debug only: whole windows to skip ahead, to watch a rotation now. */
  private skipped = 0;

  constructor(
    private settings: RotationSettings,
    private now: () => number = () => Date.now(),
  ) {}

  get intervalMs(): number {
    return this.settings.intervalMs;
  }

  /** Index of the window containing `time`. */
  windowAt(time: number): number {
    return Math.floor((time - this.settings.epochMs) / this.settings.intervalMs) + this.skipped;
  }

  /** The window in effect right now. */
  current(): number {
    return this.windowAt(this.now());
  }

  /** When `window` started (unix ms). Ranking uses this, not "now", so it is the same for everyone. */
  startOf(window: number): number {
    return this.settings.epochMs + (window - this.skipped) * this.settings.intervalMs;
  }

  /** Ms until the next rotation. */
  msUntilNext(): number {
    const elapsed = (this.now() - this.settings.epochMs) % this.settings.intervalMs;
    return this.settings.intervalMs - (elapsed < 0 ? elapsed + this.settings.intervalMs : elapsed);
  }

  /** Debug: jump to the next window immediately. */
  skip(): void {
    this.skipped++;
  }
}

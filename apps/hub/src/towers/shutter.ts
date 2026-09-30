/**
 * The vertical shutter every door uses when its world changes:
 *
 *   open → closing (drops top to bottom) → closed (REASSIGNING; content swaps
 *   once the next card is ready) → opening (rises) → open
 *
 * Pure state: no three.js and no DOM. A door reads `amount` (0 open, 1 shut)
 * each frame and draws the shutter from it; `onCue` is the hook for
 * mechanical sounds, silent unless someone plugs audio in.
 */

export type ShutterState = 'open' | 'closing' | 'closed' | 'opening';

export type ShutterCue = 'close-start' | 'closed' | 'open-start' | 'opened';

export interface ShutterTiming {
  closeS: number;
  /** Minimum time fully shut, so the swap reads as a deliberate beat. */
  holdS: number;
  openS: number;
}

/** Plug in audio later; the default plays nothing. */
export interface ShutterAudio {
  cue(cue: ShutterCue, source: { x: number; y: number; z: number } | null): void;
}

export const SILENT_SHUTTERS: ShutterAudio = { cue: () => {} };

export class ShutterMachine {
  state: ShutterState;
  /** 0 fully open, 1 fully shut. */
  amount: number;
  private elapsed = 0;
  private delay = 0;
  private ready = true;
  private swap: (() => void) | null = null;
  /** Stays shut after the swap (an empty slot). */
  private stayClosed: boolean;
  /** The close cue waits for the start delay to run out. */
  private pendingStart = false;
  private timing: ShutterTiming;
  private onCue: (cue: ShutterCue) => void;

  constructor(timing: ShutterTiming, onCue: (cue: ShutterCue) => void = () => {}, startClosed = false) {
    this.timing = timing;
    this.onCue = onCue;
    this.state = startClosed ? 'closed' : 'open';
    this.amount = startClosed ? 1 : 0;
    this.stayClosed = startClosed;
  }

  get busy(): boolean {
    return this.state !== 'open' || this.swap !== null;
  }

  /**
   * Close, run `swap` while shut, then open again once `ready` has been
   * reported. A request while one is running replaces its swap; the shutter
   * does not bounce.
   */
  cycle(swap: () => void, options: { delay?: number; waitForReady?: boolean; stayClosed?: boolean } = {}): void {
    this.swap = () => {
      swap();
      if (options.stayClosed) this.stayClosed = true;
    };
    this.ready = !options.waitForReady;
    this.stayClosed = false;
    if (this.state === 'open') {
      this.delay = options.delay ?? 0;
      this.elapsed = 0;
      this.state = 'closing';
      this.pendingStart = true;
    } else if (this.state === 'opening') {
      // Reverse from wherever it is, keeping the shutter's position.
      this.state = 'closing';
      this.elapsed = this.amount * this.timing.closeS;
      this.onCue('close-start');
    } else if (this.state === 'closed') {
      this.elapsed = 0;
    }
  }

  /** The next content is loaded (or failed to): the shutter may rise. */
  markReady(): void {
    this.ready = true;
  }

  /** Open a shutter that was left closed (e.g. an empty slot got a world). */
  open(): void {
    if (this.state === 'closed' && !this.swap) {
      this.stayClosed = false;
      this.state = 'opening';
      this.elapsed = 0;
      this.onCue('open-start');
    }
  }

  /** Jump straight to a state without animating (a door that just streamed in). */
  set(open: boolean): void {
    this.swap = null;
    this.ready = true;
    this.stayClosed = !open;
    this.pendingStart = false;
    this.state = open ? 'open' : 'closed';
    this.amount = open ? 0 : 1;
    this.elapsed = 0;
  }

  update(dt: number): number {
    switch (this.state) {
      case 'open':
        this.amount = 0;
        break;
      case 'closing': {
        if (this.delay > 0) {
          this.delay -= dt;
          break;
        }
        if (this.pendingStart) {
          this.pendingStart = false;
          this.onCue('close-start');
        }
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / this.timing.closeS);
        this.amount = dropCurve(t);
        if (t >= 1) {
          this.state = 'closed';
          this.amount = 1;
          this.elapsed = 0;
          this.onCue('closed');
          const swap = this.swap;
          this.swap = null;
          swap?.();
        }
        break;
      }
      case 'closed':
        this.amount = 1;
        this.elapsed += dt;
        if (this.swap) {
          // A new request arrived while shut: swap now.
          const swap = this.swap;
          this.swap = null;
          swap();
        }
        if (!this.stayClosed && this.ready && this.elapsed >= this.timing.holdS) {
          this.state = 'opening';
          this.elapsed = 0;
          this.onCue('open-start');
        }
        break;
      case 'opening': {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / this.timing.openS);
        this.amount = 1 - riseCurve(t);
        if (t >= 1) {
          this.state = 'open';
          this.amount = 0;
          this.onCue('opened');
        }
        break;
      }
    }
    return this.amount;
  }
}

/** Accelerates down, then settles with one small damped bounce: heavy, not violent. */
export function dropCurve(t: number): number {
  if (t < 0.8) {
    const u = t / 0.8;
    return u * u * (3 - 2 * u) * 1.0;
  }
  const u = (t - 0.8) / 0.2;
  // A 2% rebound that settles back.
  return 1 - 0.02 * Math.sin(u * Math.PI) * (1 - u);
}

/** Starts slow (breaking the seal), then lifts smoothly. */
export function riseCurve(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * u * (u * (u * 6 - 15) + 10);
}

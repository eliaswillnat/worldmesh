/** Metres walked between two footsteps. */
const STRIDE = 1.6;
/** Below this ground speed (m/s) the player is standing, not walking. */
const MIN_SPEED = 0.6;

/**
 * Footstep sounds for the local player, synthesised with Web Audio so no
 * world has to ship a sound file. Steps follow distance walked, so sprinting
 * quickens them and crouching slows them without any extra tuning.
 */
/** One audio context and noise buffer for every walker: browsers allow only a few contexts per page. */
let shared: { context: AudioContext; noise: AudioBuffer } | null = null;

export class Footsteps {
  /**
   * How loud this walker is where the listener stands: 1 for the player's own
   * feet, less for someone further off, 0 for out of earshot.
   */
  loudness = 1;
  private walked = 0;
  private left = false;
  private wasGrounded = true;
  private lastVertical = 0;
  /** Fastest fall since leaving the ground, so landings sound as hard as they were. */
  private fallSpeed = 0;

  /**
   * Call once per frame with the horizontal speed and whether feet are on the
   * ground. `footfall` says whether the avatar's foot landed this frame; when
   * the avatar's animation cannot tell (null), steps fall back to distance.
   */
  update(
    dt: number,
    speed: number,
    grounded: boolean,
    footfall: boolean | null = null,
    vertical = 0,
    flying = false,
  ): void {
    if (!flying) this.updateAir(grounded, vertical);
    this.wasGrounded = grounded;
    this.lastVertical = vertical;
    if (footfall !== null) {
      if (footfall && grounded && speed >= MIN_SPEED) this.play(Math.min(1, speed / 9));
      return;
    }
    if (!grounded || speed < MIN_SPEED) {
      // Start the next walk half a stride in, so the first step comes quickly.
      this.walked = STRIDE * 0.5;
      return;
    }
    this.walked += speed * dt;
    if (this.walked < STRIDE) return;
    this.walked -= STRIDE * (0.92 + Math.random() * 0.16);
    this.play(Math.min(1, speed / 9));
  }

  /** Jumps, double jumps and landings. */
  private updateAir(grounded: boolean, vertical: number): void {
    if (grounded) {
      if (!this.wasGrounded && this.fallSpeed > 2) this.land(Math.min(1, this.fallSpeed / 20));
      this.fallSpeed = 0;
      return;
    }
    this.fallSpeed = Math.max(this.fallSpeed, -vertical);
    const jumped = this.wasGrounded ? vertical > 1 : vertical - this.lastVertical > 3;
    if (jumped) {
      this.jump();
      this.fallSpeed = 0;
    }
  }

  /** Pushing off: a quick scuff, then a soft rush of air. Every part varies, like the steps. */
  private jump(): void {
    const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;
    this.play(0.6, { volume: 0.9 * jitter(0.3), decay: 0.7 * jitter(0.3), tone: 1.3 * jitter(0.2) });
    const audio = this.audio();
    if (!audio) return;
    const { context, noise } = audio;
    const now = context.currentTime + Math.random() * 0.02;
    const length = 0.26 * jitter(0.3);
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = jitter(0.2);
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8 * jitter(0.4);
    filter.frequency.setValueAtTime(500 * jitter(0.25), now);
    filter.frequency.exponentialRampToValueAtTime(1400 * jitter(0.3), now + length * 0.85);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.034 * jitter(0.35) * this.loudness, now + 0.06 * jitter(0.4));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now, Math.random() * (noise.duration - length - 0.05));
    source.stop(now + length + 0.02);
  }

  /**
   * Both feet coming down, heavier and longer the harder the fall. Usually one
   * lands a moment before the other, by a different amount each time.
   */
  private land(hardness: number): void {
    const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;
    const shape = () => ({
      volume: (1.4 + hardness) * jitter(0.25),
      decay: (1.4 + hardness * 0.6) * jitter(0.25),
      tone: 0.8 * jitter(0.2),
    });
    this.play(0.4 + hardness * 0.6, shape());
    if (Math.random() < 0.7) {
      const second = shape();
      second.volume *= 0.6;
      window.setTimeout(() => this.play(0.4 + hardness * 0.6, second), 15 + Math.random() * 45);
    }
  }

  /**
   * A soft scuff with a faint low thump: a step on firm ground. Every part is
   * jittered, and left and right feet differ slightly, so no two sound alike.
   */
  private play(intensity: number, shape: { volume?: number; decay?: number; tone?: number } = {}): void {
    const { volume: loudness = 1, decay: length = 1, tone = 1 } = shape;
    const audio = this.audio();
    if (!audio) return;
    const { context, noise } = audio;
    const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;
    this.left = !this.left;
    const now = context.currentTime + Math.random() * 0.025;
    const volume = (0.065 + intensity * 0.065) * jitter(0.3) * (this.left ? 1 : 0.85) * loudness * this.loudness;
    const decay = 0.09 * jitter(0.35) * length;

    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = jitter(0.25);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = (this.left ? 520 : 440) * jitter(0.3) * tone;
    filter.Q.value = 0.4 + Math.random() * 0.6;
    const gain = context.createGain();
    // A few milliseconds of attack takes the click off the start.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.008 * jitter(0.5));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    // Random offset into the noise, so each step starts on different grain.
    const offset = Math.random() * (noise.duration - decay - 0.02);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now, Math.max(0, offset));
    source.stop(now + decay + 0.02);

    const thump = context.createOscillator();
    const pitch = 85 * jitter(0.2) * Math.min(1, tone);
    thump.frequency.setValueAtTime(pitch, now);
    thump.frequency.exponentialRampToValueAtTime(pitch * 0.5, now + 0.07 * length);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(volume * 0.5 * jitter(0.4), now + 0.01);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08 * length);
    thump.connect(thumpGain).connect(context.destination);
    thump.start(now);
    thump.stop(now + 0.09 * length + 0.01);
  }

  /** The shared audio, or null when there is none, it is not running yet, or this walker is out of earshot. */
  private audio(): { context: AudioContext; noise: AudioBuffer } | null {
    if (this.loudness < 0.02) return null;
    if (!shared) {
      if (typeof AudioContext === 'undefined') return null;
      const context = new AudioContext();
      const length = Math.floor(context.sampleRate * 0.6);
      const noise = context.createBuffer(1, length, context.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      shared = { context, noise };
    }
    // Browsers start audio suspended until the page has had a click or key press.
    if (shared.context.state === 'suspended') void shared.context.resume().catch(() => undefined);
    return shared.context.state === 'running' ? shared : null;
  }

  dispose(): void {
    // The shared context stays for the other walkers; nothing of this one's is left playing.
    this.loudness = 0;
  }
}

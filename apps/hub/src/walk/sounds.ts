let context: AudioContext | null = null;

/** The lobby's one audio context, made on first use and woken if the browser suspended it. */
function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context;
}

const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;

/**
 * A soft, low, barely rising tone for a sent chat line: quiet enough to confirm
 * the send without drawing attention. Pitch and length vary a little each time.
 */
export function playSendSound(): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  const length = 0.16 * jitter(0.15);
  const pitch = 460 * jitter(0.05);

  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(pitch, now);
  tone.frequency.exponentialRampToValueAtTime(pitch * 1.12, now + length * 0.5);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.012 * jitter(0.15), now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  tone.connect(gain).connect(context.destination);
  tone.start(now);
  tone.stop(now + length + 0.02);
}

/**
 * A soft shimmer for the figure warping in (`rising`) or out: two quiet sine
 * tones gliding a fifth apart, up on arrival and down on leaving, over a faint
 * breath of air. Starts `delay` seconds from now, at `loudness` (1 for this
 * visitor's own figure, less for someone further away); varies a little each time.
 */
export function playWarpSound(rising: boolean, delay = 0, loudness = 1): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime + delay;
  const length = 0.32 * jitter(0.12);
  const low = 330 * jitter(0.04);
  const high = low * 1.6;
  const [from, to] = rising ? [low, high] : [high, low];
  const volume = 0.01 * jitter(0.15) * loudness;

  for (const [ratio, level] of [[1, 1], [1.5, 0.45]] as const) {
    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(from * ratio, now);
    tone.frequency.exponentialRampToValueAtTime(to * ratio, now + length * 0.8);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume * level, now + length * (rising ? 0.55 : 0.15));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    tone.connect(gain).connect(context.destination);
    tone.start(now);
    tone.stop(now + length + 0.02);
  }

  const samples = Math.floor(context.sampleRate * length);
  const noise = context.createBuffer(1, samples, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
  const air = context.createBufferSource();
  air.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(rising ? 900 : 2400, now);
  filter.frequency.exponentialRampToValueAtTime(rising ? 2400 : 900, now + length);
  const airGain = context.createGain();
  airGain.gain.setValueAtTime(0.0001, now);
  airGain.gain.exponentialRampToValueAtTime(volume * 0.6, now + length * 0.5);
  airGain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  air.connect(filter).connect(airGain).connect(context.destination);
  air.start(now);
  air.stop(now + length + 0.02);
}

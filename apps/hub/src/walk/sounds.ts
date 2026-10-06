let context: AudioContext | null = null;

/** The lobby's one audio context, made on first use and woken if the browser suspended it. */
function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!context) {
    context = new AudioContext();
    // Browsers keep audio off until the visitor does something; wake it then.
    const wake = () => {
      if (context?.state === 'suspended') void context.resume().catch(() => undefined);
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, wake, { capture: true });
  }
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

/** Loudest the portal hum gets, standing right in a doorway. */
const HUM_VOLUME = 0.06;
/** Seconds the hum takes to follow a change in level or direction. */
const HUM_GLIDE = 0.25;

let hum: { level: GainNode; pan: StereoPannerNode; sources: AudioScheduledSourceNode[]; bubbling: number } | null = null;
let humTarget = { level: 0, pan: 0 };

/** Soft brown noise, a few seconds long, to loop under the hum. */
function brownNoise(context: AudioContext, seconds: number): AudioBuffer {
  const samples = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, samples, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < samples; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  // Fade the seam so the loop doesn't click.
  const fade = Math.floor(context.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    data[samples - 1 - i] = data[samples - 1 - i] * (i / fade) + data[i] * (1 - i / fade);
  }
  return buffer;
}

/**
 * One bubble: a short sine whose pitch shoots upward as it fades, which is
 * what a real bubble sounds like. Size (and so pitch) varies each time.
 */
function bubble(context: AudioContext, out: AudioNode, delay: number): void {
  const now = context.currentTime + delay;
  const pitch = 380 + Math.random() * 900;
  const length = 0.04 + Math.random() * 0.06;
  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(pitch, now);
  tone.frequency.exponentialRampToValueAtTime(pitch * (1.8 + Math.random()), now + length);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.5 * jitter(0.4), now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  tone.connect(gain).connect(out);
  tone.start(now);
  tone.stop(now + length + 0.02);
}

/** A slow sine wobbling `param` by `depth` around its value, `rate` times a second. */
function wobble(context: AudioContext, param: AudioParam, rate: number, depth: number): OscillatorNode {
  const lfo = context.createOscillator();
  lfo.frequency.value = rate;
  const amount = context.createGain();
  amount.gain.value = depth;
  lfo.connect(amount).connect(param);
  lfo.start();
  return lfo;
}

/**
 * The portals' sound, built once and left running silent: bubbles popping
 * over a faint wash of water and a bright, wobbling space-warp tone.
 */
function startHum(context: AudioContext): NonNullable<typeof hum> {
  const level = context.createGain();
  level.gain.value = 0;
  const pan = context.createStereoPanner();
  level.connect(pan).connect(context.destination);
  const noise = brownNoise(context, 6);
  const sources: AudioScheduledSourceNode[] = [];

  // Water bed: a faint, steady wash underneath, no swelling.
  const wash = context.createBufferSource();
  wash.buffer = noise;
  wash.loop = true;
  const washFilter = context.createBiquadFilter();
  washFilter.type = 'bandpass';
  washFilter.Q.value = 1.2;
  washFilter.frequency.value = 900;
  const washGain = context.createGain();
  washGain.gain.value = 0.08;
  wash.connect(washFilter).connect(washGain).connect(level);
  wash.start();
  sources.push(wash);

  // Warp: a bright pair of tones beating against each other, their pitch
  // wobbling fast and drifting slowly, like light bending through water.
  for (const [pitch, loudness] of [[392, 0.16], [395.5, 0.12], [588, 0.06]] as const) {
    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = pitch;
    sources.push(wobble(context, tone.frequency, 5.5, pitch * 0.012));
    sources.push(wobble(context, tone.frequency, 0.23, pitch * 0.06));
    const gain = context.createGain();
    gain.gain.value = loudness;
    tone.connect(gain).connect(level);
    tone.start();
    sources.push(tone);
  }

  // Bubbles: little pops, more of them the closer the portal.
  const bubbling = window.setInterval(() => {
    if (document.hidden || Math.random() > humTarget.level * 0.8) return;
    bubble(context, level, Math.random() * 0.08);
  }, 70);

  return { level, pan, sources, bubbling };
}

function applyHum(): void {
  if (!hum || !context) return;
  const level = document.hidden ? 0 : humTarget.level;
  hum.level.gain.setTargetAtTime(level * HUM_VOLUME, context.currentTime, HUM_GLIDE);
  hum.pan.pan.setTargetAtTime(humTarget.pan, context.currentTime, HUM_GLIDE);
}

/**
 * How loud the portal hum is (0 silent to 1 in the doorway) and where it
 * comes from (-1 left to 1 right). Call every frame; the sound itself starts
 * on the first call where it should be heard and once the browser lets audio play.
 */
export function setPortalHum(level: number, pan: number): void {
  if (level === humTarget.level && pan === humTarget.pan && hum) return;
  humTarget = { level, pan };
  if (!hum) {
    if (level <= 0 || typeof AudioContext === 'undefined') return;
    // Made here if need be, but woken only by a gesture, not every frame.
    const sound = context ?? audio();
    if (sound?.state !== 'running') return;
    hum = startHum(sound);
    document.addEventListener('visibilitychange', applyHum);
  }
  applyHum();
}

/** Silence the hum and let it go, when the lobby closes. */
export function stopPortalHum(): void {
  if (!hum) return;
  window.clearInterval(hum.bubbling);
  for (const source of hum.sources) source.stop();
  hum.level.disconnect();
  hum = null;
  humTarget = { level: 0, pan: 0 };
  document.removeEventListener('visibilitychange', applyHum);
}

/**
 * Someone plunging through a portal: a burst of bubbles rushing upward over a
 * falling watery whoosh. `loudness` is 1 for this visitor, less further away.
 */
export function playPortalSplash(loudness = 1): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  const out = context.createGain();
  out.gain.value = 0.05 * loudness;
  out.connect(context.destination);

  const length = 0.7;
  const samples = Math.floor(context.sampleRate * length);
  const noise = context.createBuffer(1, samples, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
  const whoosh = context.createBufferSource();
  whoosh.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 2.5;
  filter.frequency.setValueAtTime(2200, now);
  filter.frequency.exponentialRampToValueAtTime(260, now + length);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.5, now + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  whoosh.connect(filter).connect(gain).connect(out);
  whoosh.start(now);
  whoosh.stop(now + length + 0.02);

  for (let i = 0; i < 14; i++) bubble(context, out, Math.random() * 0.45);
}

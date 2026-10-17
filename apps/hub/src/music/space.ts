/**
 * Where the lobby music comes from and how the hall makes it sound: it rises
 * from the middle of the hall, is loudest there, softens towards the wall,
 * and outside the wall it is muffled and fades away as you walk off. The hall
 * itself is a huge hard room under a glass dome, so everything comes back as
 * a long, dark reverberation, with a faint echo off the far wall.
 */

/** Height above the floor the music seems to come from, in metres. */
const SOURCE_HEIGHT = 2.5;
/** Level at the hall's wall, against 1 in the middle. */
const AT_WALL = 0.4;
/** Metres past the wall over which the music fades to nothing. */
export const OUTSIDE_FADE_M = 35;
/** Seconds for a sound to die away in the hall (RT60). */
const REVERB_S = 4.8;
/** How loud the hall's reverberation is, against the music itself (×). */
const ROOM_GAIN = 5;
/** The echo off the far side of the dome: 118 m across and back at ~343 m/s. */
const ECHO_DELAY_S = 0.34;

export interface Hearing {
  /** Overall level, 0–1. */
  level: number;
  /** How much of the hall's reverberation comes back, against the music itself. */
  reverb: number;
  /** Highest frequency that gets through, in Hz: walls muffle it outside. */
  cutoff: number;
}

const smoothstep = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

/** Metres from where the music comes from to someone standing at (x, y, z), with their feet at y. */
export function distanceToSource(x: number, y: number, z: number): number {
  return Math.hypot(x, y - SOURCE_HEIGHT, z);
}

/**
 * What someone this far from the music hears, in a hall of this radius:
 * full in the middle, softer and more reverberant towards the wall, then
 * muffled and fading to silence over OUTSIDE_FADE_M past it.
 */
export function hearing(distance: number, radius: number): Hearing {
  const inside = Math.min(distance / radius, 1);
  const out = smoothstep((distance - radius) / OUTSIDE_FADE_M);
  return {
    level: (1 - (1 - AT_WALL) * Math.pow(inside, 1.3)) * (1 - out),
    // Further from the music, more of what reaches you is the room.
    reverb: 0.75 + 0.5 * inside + 0.4 * out,
    // Darkening from a few metres inside the wall, as the doorways take over from open air.
    cutoff: 18000 * Math.pow(600 / 18000, Math.min(Math.max((distance - radius + 6) / (6 + OUTSIDE_FADE_M * 0.6), 0), 1)),
  };
}

/** Whether the music can be heard at all from this far away. */
export function audible(distance: number, radius: number): boolean {
  return distance < radius + OUTSIDE_FADE_M;
}

/**
 * A made-up impulse response for the hall: a few early reflections, then a
 * dense tail that dies away over REVERB_S and darkens as it goes (the high
 * frequencies fade first, as they do off glass and stone). Two channels that
 * differ, so the room sounds wide.
 */
function hallResponse(context: BaseAudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.floor(rate * REVERB_S);
  const predelay = Math.floor(rate * 0.025);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = predelay; i < length; i++) {
      const t = (i - predelay) / rate;
      // -60 dB over REVERB_S.
      const envelope = Math.exp((-6.9 * t) / REVERB_S);
      // Brightness falls from open to dark across the tail.
      const brightness = 0.85 * Math.exp(-t * 1.6) + 0.06;
      low += brightness * (Math.random() * 2 - 1 - low);
      data[i] = low * envelope;
    }
    // Early reflections off the floor and the near wall, different on each side.
    for (const [ms, gain] of channel === 0 ? [[19, 0.5], [43, 0.35], [71, 0.25]] : [[23, 0.5], [51, 0.32], [83, 0.22]]) {
      data[predelay + Math.floor((rate * ms) / 1000)] += gain;
    }
  }
  return buffer;
}

export interface HallMix {
  /** Where the music goes in. */
  input: AudioNode;
  /** Set what the listener hears, smoothly, starting now. */
  hear(hearing: Hearing, volume: number): void;
}

/**
 * The hall between the music and the speakers:
 *   input → level → muffle ─┬─ dry ──────────────────────────────┐
 *                           ├─ thin → darken → reverb → room ────┤→ out
 *                           └─ echo (delay, fed back, darkened) ─┘
 */
export function createHallMix(context: BaseAudioContext, destination: AudioNode): HallMix {
  const level = context.createGain();
  level.gain.value = 0;
  const muffle = context.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 18000;
  muffle.Q.value = 0.5;
  level.connect(muffle);

  const dry = context.createGain();
  dry.gain.value = 0.55;
  muffle.connect(dry).connect(destination);

  // The reverberation: low rumble and harsh highs left out, so it blooms instead of booming or hissing.
  const thin = context.createBiquadFilter();
  thin.type = 'highpass';
  thin.frequency.value = 180;
  const darken = context.createBiquadFilter();
  darken.type = 'lowpass';
  darken.frequency.value = 5000;
  const reverb = context.createConvolver();
  reverb.buffer = hallResponse(context);
  const room = context.createGain();
  room.gain.value = ROOM_GAIN;
  muffle.connect(thin).connect(darken).connect(reverb).connect(room).connect(destination);

  // The faint repeat off the far wall, each one softer and duller than the last.
  const delay = context.createDelay(1);
  delay.delayTime.value = ECHO_DELAY_S;
  const dull = context.createBiquadFilter();
  dull.type = 'lowpass';
  dull.frequency.value = 2200;
  const feedback = context.createGain();
  feedback.gain.value = 0.32;
  const echo = context.createGain();
  echo.gain.value = 0.16;
  muffle.connect(delay).connect(dull).connect(feedback).connect(delay);
  dull.connect(echo).connect(destination);

  return {
    input: level,
    hear({ level: amount, reverb: wet, cutoff }, volume) {
      const at = context.currentTime;
      level.gain.setTargetAtTime(amount * volume, at, 0.25);
      room.gain.setTargetAtTime(wet * ROOM_GAIN, at, 0.25);
      muffle.frequency.setTargetAtTime(cutoff, at, 0.25);
    },
  };
}

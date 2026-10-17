/**
 * The push-to-talk wire format. The relay (templates/relay) is deployed on its
 * own, so it keeps its own copy of VOICE_KIND and VOICE_ID_BYTES.
 *
 * Voice goes up the presence WebSocket as binary frames, not peer to peer, so
 * nobody sees anyone else's IP address. A frame is 80 ms of 16 kHz μ-law
 * (G.711, telephone-style 8-bit samples): 1280 bytes, 16 KB a second while
 * someone holds the talk button and nothing at all otherwise. Every browser
 * can make and play it with plain Web Audio, no codec support needed.
 *
 *   client → server  [1, ...samples]            this visitor talking
 *   server → client  [1, ...id (8 bytes), ...samples]   someone within earshot talking
 *
 * The id is the sender's presence id, as ASCII, padded with spaces.
 */

/** First byte of a binary frame that carries voice. */
export const VOICE_KIND = 1;
/** Samples a second on the wire. */
export const VOICE_RATE = 16_000;
/** Samples per frame: 80 ms. */
export const VOICE_FRAME = 1280;
/** Bytes of sender id the relay puts after the kind byte. */
export const VOICE_ID_BYTES = 8;

const BIAS = 0x84;
const CLIP = 32635;

/** One sample (-1…1) as a μ-law byte. */
export function encodeMuLaw(sample: number): number {
  let value = Math.round(Math.max(-1, Math.min(1, sample || 0)) * 32767);
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  if (value > CLIP) value = CLIP;
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Every μ-law byte as a sample, worked out once. */
const DECODED = new Float32Array(256);
for (let byte = 0; byte < 256; byte++) {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + BIAS) << exponent) - BIAS;
  DECODED[byte] = ((u & 0x80) ? -magnitude : magnitude) / 32768;
}

/** μ-law bytes back to samples. */
export function decodeMuLaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODED[bytes[i]];
  return out;
}

/**
 * Turns the microphone's rate (usually 48 kHz) into 16 kHz as it streams in.
 * Each output sample is the average of the input it covers, which keeps
 * hiss above 8 kHz from folding back into the voice.
 */
export class Downsampler {
  private readonly ratio: number;
  private sum = 0;
  private filled = 0;

  constructor(inputRate: number, outputRate = VOICE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array, emit: (sample: number) => void): void {
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      let weight = 1;
      while (this.filled + weight >= this.ratio) {
        const take = this.ratio - this.filled;
        emit((this.sum + sample * take) / this.ratio);
        weight -= take;
        this.sum = 0;
        this.filled = 0;
      }
      this.sum += sample * weight;
      this.filled += weight;
    }
  }

  reset(): void {
    this.sum = 0;
    this.filled = 0;
  }
}

/** The frame the relay hands on: kind, the sender's id, then their samples. */
export function voiceFrameFrom(id: string, samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + VOICE_ID_BYTES + samples.length);
  out[0] = VOICE_KIND;
  for (let i = 0; i < VOICE_ID_BYTES; i++) out[1 + i] = i < id.length ? id.charCodeAt(i) & 0x7f : 0x20;
  out.set(samples, 1 + VOICE_ID_BYTES);
  return out;
}

/** Who is talking and what they said, from a frame the relay handed on; null for anything else. */
export function readVoiceFrame(data: ArrayBuffer | Uint8Array): { id: string; samples: Uint8Array } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length <= 1 + VOICE_ID_BYTES || bytes[0] !== VOICE_KIND) return null;
  let id = '';
  for (let i = 0; i < VOICE_ID_BYTES; i++) id += String.fromCharCode(bytes[1 + i]);
  return { id: id.trimEnd(), samples: bytes.subarray(1 + VOICE_ID_BYTES) };
}

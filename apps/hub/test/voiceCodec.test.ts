import { describe, expect, it } from 'vitest';
import {
  Downsampler,
  VOICE_FRAME,
  VOICE_ID_BYTES,
  VOICE_KIND,
  decodeMuLaw,
  encodeMuLaw,
  readVoiceFrame,
  voiceFrameFrom,
} from '../../../packages/runtime/src/net/voiceCodec.ts';

describe('μ-law', () => {
  it('matches G.711 for silence and the extremes', () => {
    expect(encodeMuLaw(0)).toBe(0xff);
    expect(encodeMuLaw(1)).toBe(0x80);
    expect(encodeMuLaw(-1)).toBe(0x00);
    expect(decodeMuLaw(new Uint8Array([0xff]))[0]).toBe(0);
  });

  it('comes back close to what went in, loud or quiet', () => {
    for (const sample of [-0.9, -0.3, -0.05, -0.002, 0.002, 0.05, 0.3, 0.9]) {
      const back = decodeMuLaw(new Uint8Array([encodeMuLaw(sample)]))[0];
      expect(Math.sign(back)).toBe(Math.sign(sample));
      // About 3% of the level, plus a hair near silence.
      expect(Math.abs(back - sample)).toBeLessThan(Math.abs(sample) * 0.035 + 0.0005);
    }
  });

  it('clips past full scale and ignores NaN', () => {
    expect(encodeMuLaw(4)).toBe(encodeMuLaw(1));
    expect(encodeMuLaw(Number.NaN)).toBe(encodeMuLaw(0));
  });
});

describe('Downsampler', () => {
  it('turns 48 kHz into 16 kHz, one sample out for every three in', () => {
    const out: number[] = [];
    const downsampler = new Downsampler(48_000);
    downsampler.push(new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6, 0.9]), (sample) => out.push(sample));
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(0.6, 6);
  });

  it('keeps the rate exact across blocks at 44.1 kHz', () => {
    let count = 0;
    const downsampler = new Downsampler(44_100);
    for (let block = 0; block < 441; block++) downsampler.push(new Float32Array(100).fill(0.5), () => count++);
    // One second in, one second out, give or take the sample still filling.
    expect(Math.abs(count - 16_000)).toBeLessThanOrEqual(1);
  });

  it('averages away a tone too high for 16 kHz', () => {
    const out: number[] = [];
    const downsampler = new Downsampler(48_000);
    // 24 kHz: +1, -1, +1, … averages to a third at most.
    const tone = Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? -1 : 1));
    downsampler.push(tone, (sample) => out.push(sample));
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(1 / 3 + 1e-6);
  });

  it('starts clean after a reset', () => {
    const out: number[] = [];
    const downsampler = new Downsampler(48_000);
    downsampler.push(new Float32Array([1, 1]), (sample) => out.push(sample));
    downsampler.reset();
    downsampler.push(new Float32Array([0, 0, 0]), (sample) => out.push(sample));
    expect(out).toEqual([0]);
  });
});

describe('voice frames', () => {
  it('carries the sender id and samples through the relay format', () => {
    const samples = new Uint8Array(VOICE_FRAME).map((_, i) => i & 0xff);
    const frame = voiceFrameFrom('a1b2c3d4', samples);
    expect(frame[0]).toBe(VOICE_KIND);
    expect(frame.length).toBe(1 + VOICE_ID_BYTES + VOICE_FRAME);
    const read = readVoiceFrame(frame.buffer as ArrayBuffer);
    expect(read?.id).toBe('a1b2c3d4');
    expect([...read!.samples]).toEqual([...samples]);
  });

  it('pads a short id and trims it back', () => {
    expect(readVoiceFrame(voiceFrameFrom('abc', new Uint8Array([1])))?.id).toBe('abc');
  });

  it('ignores anything that is not a voice frame', () => {
    expect(readVoiceFrame(new Uint8Array([2, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(readVoiceFrame(new Uint8Array([VOICE_KIND, 1, 2]))).toBeNull();
  });
});

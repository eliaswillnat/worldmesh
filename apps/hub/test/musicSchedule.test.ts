import { describe, expect, it } from 'vitest';
import { FADE_S, roundLength, roundOrder, slotLevel, slotsBetween } from '../src/music/schedule';
import { TRACKS } from '../src/music/tracks';

describe('music schedule', () => {
  it('plays every song once per round', () => {
    for (const round of [0, 1, 2, 500]) expect(new Set(roundOrder(TRACKS, round)).size).toBe(TRACKS.length);
  });

  it('never plays the same song twice in a row, across rounds too', () => {
    const length = roundLength(TRACKS);
    const slots = slotsBetween(TRACKS, 0, length * 40);
    for (let i = 1; i < slots.length; i++) expect(slots[i].track).not.toBe(slots[i - 1].track);
  });

  it('overlaps each song with the next by exactly the crossfade', () => {
    const slots = slotsBetween(TRACKS, 1000, 1000 + roundLength(TRACKS) * 3);
    for (let i = 1; i < slots.length; i++) expect(slots[i].start).toBeCloseTo(slots[i - 1].end - FADE_S, 6);
  });

  it('always has something playing, and at most two songs at once', () => {
    const length = roundLength(TRACKS);
    for (let t = 0; t < length * 3; t += 0.7) {
      const sounding = slotsBetween(TRACKS, t, t).filter((s) => s.start <= t && t < s.end);
      expect(sounding.length).toBeGreaterThanOrEqual(1);
      expect(sounding.length).toBeLessThanOrEqual(2);
    }
  });

  it('gives everyone the same song at the same moment', () => {
    const t = 23_456_789.5;
    expect(slotsBetween(TRACKS, t, t)).toEqual(slotsBetween(TRACKS, t, t));
    expect(slotsBetween(TRACKS, t, t).map((s) => s.track.file)).toEqual(slotsBetween([...TRACKS], t, t).map((s) => s.track.file));
  });

  it('fades in and out over the crossfade, full in between', () => {
    const [slot] = slotsBetween(TRACKS, 5000, 5000);
    expect(slotLevel(slot, slot.start)).toBe(0);
    expect(slotLevel(slot, slot.start + FADE_S / 2)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(slotLevel(slot, slot.start + FADE_S + 1)).toBe(1);
    expect(slotLevel(slot, slot.end)).toBe(0);
  });
});

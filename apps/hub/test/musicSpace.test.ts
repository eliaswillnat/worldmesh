import { describe, expect, it } from 'vitest';
import { OUTSIDE_FADE_M, audible, distanceToSource, hearing } from '../src/music/space';

const R = 59;

describe('music space', () => {
  it('is loudest in the middle and softens towards the wall', () => {
    const levels = [0, 10, 20, 30, 40, 50, R].map((d) => hearing(d, R).level);
    expect(levels[0]).toBeCloseTo(1, 6);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThan(levels[i - 1]);
    expect(hearing(R, R).level).toBeGreaterThan(0.3);
  });

  it('fades out smoothly past the wall, with no jump at the doorway', () => {
    expect(Math.abs(hearing(R + 0.01, R).level - hearing(R - 0.01, R).level)).toBeLessThan(0.01);
    expect(hearing(R + OUTSIDE_FADE_M / 2, R).level).toBeLessThan(hearing(R, R).level / 1.5);
    expect(hearing(R + OUTSIDE_FADE_M, R).level).toBe(0);
    expect(audible(R + OUTSIDE_FADE_M - 1, R)).toBe(true);
    expect(audible(R + OUTSIDE_FADE_M + 1, R)).toBe(false);
  });

  it('gets more reverberant and more muffled further away', () => {
    const near = hearing(5, R);
    const wall = hearing(R, R);
    const outside = hearing(R + 20, R);
    expect(wall.reverb).toBeGreaterThan(near.reverb);
    expect(outside.reverb).toBeGreaterThan(wall.reverb);
    expect(near.cutoff).toBeGreaterThan(15000);
    expect(outside.cutoff).toBeLessThan(wall.cutoff);
    expect(outside.cutoff).toBeLessThan(3000);
  });

  it('measures from a point above the middle of the floor, in all three directions', () => {
    expect(distanceToSource(0, 2.5, 0)).toBe(0);
    expect(distanceToSource(3, 2.5, 4)).toBeCloseTo(5, 6);
    expect(distanceToSource(0, 22.5, 0)).toBeCloseTo(20, 6);
  });
});

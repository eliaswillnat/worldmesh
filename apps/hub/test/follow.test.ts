import { describe, expect, it } from 'vitest';
import { easeYaw } from '../../../packages/runtime/src/net/follow.ts';

describe('easeYaw', () => {
  it('moves the given share of the way', () => {
    expect(easeYaw(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(easeYaw(0, 1, 0)).toBe(0);
    expect(easeYaw(0, 1, 1)).toBeCloseTo(1);
  });

  it('turns the short way round across ±π', () => {
    // From just under π to just over -π is a small step forward, not a full turn back.
    const next = easeYaw(3, -3, 1);
    expect(next).toBeCloseTo(3 + (2 * Math.PI - 6));
    expect(easeYaw(-3, 3, 0.5)).toBeLessThan(-3);
  });

  it('ignores whole turns between the two', () => {
    expect(easeYaw(0, 4 * Math.PI + 0.2, 1)).toBeCloseTo(0.2);
    expect(easeYaw(10 * Math.PI, 0.1, 1)).toBeCloseTo(10 * Math.PI + 0.1);
  });
});

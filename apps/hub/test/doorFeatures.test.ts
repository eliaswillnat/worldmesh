import { describe, expect, it } from 'vitest';
import { doorFeatures, worldIsFull } from '../src/walk/door';

describe('doorFeatures', () => {
  it('turns known tags into labels, in a fixed order, ignoring case', () => {
    expect(doorFeatures(['VR', 'Multiplayer', 'puzzle'])).toEqual(['Multiplayer', 'VR supported']);
  });

  it('counts each feature once, whichever of its tags are set', () => {
    expect(doorFeatures(['webxr', 'vr', 'coop'])).toEqual(['Multiplayer', 'VR supported']);
  });

  it('shows at most three', () => {
    expect(doorFeatures(['multiplayer', 'vr', 'ar', 'mobile', 'gamepad'])).toHaveLength(3);
  });

  it('is empty without tags', () => {
    expect(doorFeatures(undefined)).toEqual([]);
  });
});

describe('worldIsFull', () => {
  it('is full at and above the live cap', () => {
    expect(worldIsFull(16, 16)).toBe(true);
    expect(worldIsFull(17, 16)).toBe(true);
  });

  it('is not full below the cap', () => {
    expect(worldIsFull(15, 16)).toBe(false);
    expect(worldIsFull(0, 16)).toBe(false);
  });

  it('ignores nonsense numbers', () => {
    expect(worldIsFull(16, 0)).toBe(false);
    expect(worldIsFull(Number.NaN, 16)).toBe(false);
  });
});

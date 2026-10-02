import { describe, expect, it } from 'vitest';
import { doorFeatures } from '../src/walk/door';

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

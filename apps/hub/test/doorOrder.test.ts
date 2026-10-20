import { describe, expect, it } from 'vitest';
import { assignDoors, type DoorOrderWorld } from '../src/walk/doorOrder';

const world = (url: string, extra: Partial<DoorOrderWorld> = {}): DoorOrderWorld => ({ url, addedAt: '2026-01-01T00:00:00Z', ...extra });

describe('door order', () => {
  const worlds = [
    world('https://solo-old.example', { addedAt: '2025-01-01T00:00:00Z' }),
    world('https://solo-new.example', { addedAt: '2026-06-01T00:00:00Z' }),
    world('https://busy.example'),
    world('https://together.example', { tags: ['multiplayer'] }),
    world('https://leniverse.com/?galaxy=1', { tags: ['multiplayer'] }),
    world('https://demo.example', { tags: ['multiplayer'], source: 'demo' }),
  ];

  it('keeps multiplayer worlds in the hall, the demos first, and the rest in the city, newest first without counts', () => {
    expect(assignDoors(worlds, 10)).toEqual({
      // Added the same day: by URL.
      inside: ['https://demo.example', 'https://leniverse.com/?galaxy=1', 'https://together.example'],
      city: ['https://solo-new.example', 'https://busy.example', 'https://solo-old.example'],
    });
  });

  it('puts the most entered worlds nearest the hall, and the least entered furthest out', () => {
    const entries: Record<string, number> = { 'https://solo-old.example': 40, 'https://busy.example': 900 };
    expect(assignDoors(worlds, 10, (url) => entries[url]).city).toEqual(['https://busy.example', 'https://solo-old.example', 'https://solo-new.example']);
  });

  it('sends a multiplayer world with a building of its own out to the city, in its place by entries', () => {
    const entries: Record<string, number> = { 'https://leniverse.com/?galaxy=1': 120, 'https://busy.example': 900 };
    const assigned = assignDoors(worlds, 10, (url) => entries[url], (url) => url.startsWith('https://leniverse.com'));
    expect(assigned.inside).toEqual(['https://demo.example', 'https://together.example']);
    expect(assigned.city).toEqual(['https://busy.example', 'https://leniverse.com/?galaxy=1', 'https://solo-new.example', 'https://solo-old.example']);
  });

  it('sends multiplayer worlds that do not fit inside out to the city too', () => {
    expect(assignDoors(worlds, 1)).toEqual({
      inside: ['https://demo.example'],
      city: ['https://solo-new.example', 'https://busy.example', 'https://leniverse.com/?galaxy=1', 'https://together.example', 'https://solo-old.example'],
    });
  });
});

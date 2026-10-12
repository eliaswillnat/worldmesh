import { describe, expect, it } from 'vitest';
import { CORNER_HALF, PIER_WIDTH, STOREFRONT_HALF, STOREFRONT_WIDTH, planFacade, type FacadeLayout } from '../src/walk/facade';
import { DOOR_HALF_SPAN } from '../src/walk/door';

/** Every piece of the wall, in order along it. */
function pieces(layout: FacadeLayout): Array<{ start: number; end: number; kind: string }> {
  return [
    ...layout.piers.map((span) => ({ ...span, kind: 'pier' })),
    ...layout.storefronts.map((front) => ({ start: front.start + PIER_WIDTH / 2, end: front.end - PIER_WIDTH / 2, kind: 'store' })),
    ...layout.blanks.map((span) => ({ ...span, kind: 'blank' })),
  ].sort((a, b) => a.start - b.start);
}

/** The wall is covered corner to corner, with nothing overlapping. */
function expectTiled(layout: FacadeLayout, length: number): void {
  const parts = pieces(layout);
  expect(parts[0].start).toBeCloseTo(0);
  expect(parts[parts.length - 1].end).toBeCloseTo(length);
  for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBeCloseTo(parts[i - 1].end);
  for (const part of parts) expect(part.end).toBeGreaterThan(part.start);
}

describe('storefront façade', () => {
  it('covers a blank wall with bays of even width between corner piers', () => {
    const length = 60;
    const layout = planFacade(length, []);
    expectTiled(layout, length);
    expect(layout.storefronts).toHaveLength(0);
    const widths = layout.blanks.map((bay) => bay.end - bay.start);
    for (const width of widths) expect(width).toBeCloseTo(widths[0]);
    expect(widths[0]).toBeGreaterThan(STOREFRONT_HALF * 0.6);
    expect(widths[0]).toBeLessThan(STOREFRONT_HALF * 1.5);
    expect(layout.piers[0].start).toBe(0);
    expect(layout.piers[layout.piers.length - 1].end).toBe(length);
  });

  it('gives each door its own bay, centred on it, with the sign between its piers', () => {
    for (const doors of [[30], [17, 43], [10, 30, 50]]) {
      const layout = planFacade(60, doors);
      expectTiled(layout, 60);
      expect(layout.storefronts.map((front) => front.door).sort()).toEqual(doors.map((_, i) => i));
      for (const front of layout.storefronts) {
        const at = doors[front.door];
        expect((front.start + front.end) / 2).toBeCloseTo(at);
        expect((front.sign.start + front.sign.end) / 2).toBeCloseTo(at);
        expect(front.end - front.start).toBeCloseTo(STOREFRONT_WIDTH);
        // The doorway, frame and all, fits between the piers.
        expect(front.start + PIER_WIDTH / 2).toBeLessThan(at - DOOR_HALF_SPAN);
        expect(front.end - PIER_WIDTH / 2).toBeGreaterThan(at + DOOR_HALF_SPAN);
      }
    }
  });

  it('widens a pier rather than leave a sliver of a bay', () => {
    // Two storefronts 1.2 m apart: one pier between them, no blank bay.
    const a = 20;
    const b = a + STOREFRONT_WIDTH + 1.2;
    const layout = planFacade(60, [a, b]);
    expectTiled(layout, 60);
    const between = layout.blanks.filter((bay) => bay.start > a && bay.end < b);
    expect(between).toHaveLength(0);
    // A door close to a corner runs its pier into the corner pier.
    const near = planFacade(30, [CORNER_HALF + STOREFRONT_HALF + 1]);
    expectTiled(near, 30);
    expect(near.piers[0].start).toBe(0);
    expect(near.piers[0].end).toBeCloseTo(CORNER_HALF + 1 + PIER_WIDTH / 2);
  });

  it('skips the recessed panel in a bay too narrow for one', () => {
    const layout = planFacade(60, [30]);
    for (const bay of layout.blanks) expect(bay.panel).toBe(bay.end - bay.start > 2.5);
  });
});

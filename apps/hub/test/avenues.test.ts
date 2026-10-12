import { describe, expect, it } from 'vitest';
import { AVENUES, planAvenues, ringInner } from '../src/walk/avenuePlan';
import { blockOutline, prismRoof, prismWalls } from '../src/walk/avenues';

const HUB = 60.2;
const SPOKES = 8;
const SLOT = 13.1;

/** An angle brought into -π..π. */
const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

describe('avenue plan', () => {
  it('keeps at least the minimum rings, and grows a ring when doors run out', () => {
    const empty = planAvenues(HUB, SPOKES, 0, SLOT);
    expect(empty.rings).toBe(AVENUES.minRings);
    expect(empty.blocks).toHaveLength(AVENUES.minRings * SPOKES);
    expect(empty.slots).toHaveLength(0);
    const more = planAvenues(HUB, SPOKES, empty.capacity + 1, SLOT);
    expect(more.rings).toBe(AVENUES.minRings + 1);
    expect(more.radius).toBeGreaterThan(empty.radius);
    expect(planAvenues(HUB, SPOKES, 100_000, SLOT).rings).toBe(AVENUES.maxRings);
  });

  it('gives a door to every world that fits, and keeps each in its block as the city grows', () => {
    const small = planAvenues(HUB, SPOKES, 20, SLOT);
    expect(small.slots).toHaveLength(20);
    const large = planAvenues(HUB, SPOKES, small.capacity + 50, SLOT);
    small.slots.forEach((slot, i) => {
      expect([large.slots[i].ring, large.slots[i].sector]).toEqual([slot.ring, slot.sector]);
      // The same wall: a door on a curved wall turns a little as it moves along it, no more.
      expect(large.slots[i].facingX * slot.facingX + large.slots[i].facingZ * slot.facingZ).toBeGreaterThan(0.7);
    });
  });

  it('centres a lone door on its wall, in the middle of its block', () => {
    const plan = planAvenues(HUB, SPOKES, SPOKES, SLOT);
    for (const slot of plan.slots) {
      const block = plan.blocks.find((b) => b.ring === slot.ring && b.sector === slot.sector)!;
      expect(turn(Math.atan2(slot.x, slot.z) - (block.from + block.to) / 2)).toBeCloseTo(0, 6);
      // On the wall facing the rotunda.
      expect(Math.hypot(slot.x, slot.z)).toBeLessThan(block.inner);
    }
  });

  it('shares a wall evenly between its doors', () => {
    const plan = planAvenues(HUB, SPOKES, SPOKES * 2, SLOT);
    for (let sector = 0; sector < SPOKES; sector++) {
      const block = plan.blocks.find((b) => b.ring === 0 && b.sector === sector)!;
      const middle = (block.from + block.to) / 2;
      const offsets = plan.slots.filter((slot) => slot.sector === sector).map((slot) => turn(Math.atan2(slot.x, slot.z) - middle));
      expect(offsets).toHaveLength(2);
      expect(offsets[0] + offsets[1]).toBeCloseTo(0, 6);
    }
  });

  it('runs an avenue straight out of every gate', () => {
    const plan = planAvenues(HUB, SPOKES, 0, SLOT);
    const step = (Math.PI * 2) / SPOKES;
    for (const block of plan.blocks) {
      expect(block.from).toBeCloseTo(block.sector * step);
      expect(block.to).toBeCloseTo((block.sector + 1) * step);
    }
    // No block reaches into an avenue: every corner stays half an avenue from both centre lines.
    for (const block of plan.blocks) {
      for (const [x, z] of blockOutline(block, plan.halfAvenue)) {
        for (const angle of [block.from, block.to]) {
          const across = Math.abs(x * Math.cos(angle) - z * Math.sin(angle));
          expect(across).toBeGreaterThanOrEqual(plan.halfAvenue - 1e-6);
        }
      }
    }
  });

  it('leaves the plaza and the ring streets open', () => {
    const plan = planAvenues(HUB, SPOKES, 0, SLOT);
    expect(ringInner(HUB, 0)).toBe(HUB + AVENUES.plaza);
    for (const block of plan.blocks) {
      const next = plan.blocks.find((other) => other.ring === block.ring + 1);
      if (next) expect(next.inner - block.outer).toBeCloseTo(AVENUES.ringStreet);
    }
  });

  it('puts door places in the streets, facing away from their block, clear of each other', () => {
    const plan = planAvenues(HUB, SPOKES, 200, SLOT);
    for (const slot of plan.slots) {
      expect(Math.hypot(slot.facingX, slot.facingZ)).toBeCloseTo(1);
      // The point behind the door is on the block's wall.
      const block = plan.blocks.find((b) => b.ring === slot.ring && b.sector === slot.sector)!;
      const wx = slot.x - slot.facingX * slot.out;
      const wz = slot.z - slot.facingZ * slot.out;
      const r = Math.hypot(wx, wz);
      expect(r).toBeGreaterThanOrEqual(block.inner - 1e-6);
      expect(r).toBeLessThanOrEqual(block.outer + 1e-6);
      // A step out from the door is outside the block.
      const sx = slot.x + slot.facingX;
      const sz = slot.z + slot.facingZ;
      const sr = Math.hypot(sx, sz);
      const angle = Math.atan2(sx, sz);
      const inBand = sr > block.inner && sr < block.outer;
      const acrossFrom = sx * Math.cos(block.from) - sz * Math.sin(block.from);
      const acrossTo = -(sx * Math.cos(block.to) - sz * Math.sin(block.to));
      const between = acrossFrom > plan.halfAvenue && acrossTo > plan.halfAvenue;
      expect(inBand && between, `slot at angle ${angle}`).toBe(false);
    }
    // Side by side along a wall, a whole porch apart; round a block's corner, each clear of the other's porch.
    for (const a of plan.slots) {
      for (const b of plan.slots) {
        if (a === b) continue;
        const alongside = a.facingX * b.facingX + a.facingZ * b.facingZ > 0.95;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(alongside ? SLOT : SLOT / 2 + 2);
      }
    }
  });

  it('fills the nearest ring first, round every avenue', () => {
    const plan = planAvenues(HUB, SPOKES, 1000, SLOT);
    const firstRing = plan.slots.filter((slot) => slot.ring === 0).length;
    expect(plan.slots.slice(0, firstRing).every((slot) => slot.ring === 0)).toBe(true);
    expect(new Set(plan.slots.slice(0, SPOKES).map((slot) => slot.sector)).size).toBe(SPOKES);
  });
});

describe('block geometry', () => {
  const plan = planAvenues(HUB, SPOKES, 0, SLOT);
  const block = plan.blocks[3];
  const outline = blockOutline(block, plan.halfAvenue);
  const cx = outline.reduce((sum, [x]) => sum + x, 0) / outline.length;
  const cz = outline.reduce((sum, [, z]) => sum + z, 0) / outline.length;

  it('faces every wall out, so collisions push walkers back into the street', () => {
    const walls = prismWalls(outline, 0, 10);
    const position = walls.getAttribute('position');
    for (let i = 0; i < position.count; i += 3) {
      const [ax, ay, az] = [position.getX(i), position.getY(i), position.getZ(i)];
      const [bx, by, bz] = [position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)];
      const [px, py, pz] = [position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)];
      const [ux, uy, uz] = [bx - ax, by - ay, bz - az];
      const [vx, vy, vz] = [px - ax, py - ay, pz - az];
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      const mx = (ax + bx + px) / 3 - cx;
      const mz = (az + bz + pz) / 3 - cz;
      expect(nx * mx + nz * mz).toBeGreaterThan(0);
    }
  });

  it('faces the roof up', () => {
    const roof = prismRoof(outline, 14);
    const normal = roof.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).toBeCloseTo(1);
  });
});

import { describe, expect, it } from 'vitest';
import { AVENUES, blockFaces, planAvenues, ringInner } from '../src/walk/avenuePlan';
import { blockOutline, buildAvenues, dressHall, faceBox, prismRoof, prismWalls } from '../src/walk/avenues';
import { Matrix4 } from 'three';
import { STOREFRONT_WIDTH } from '../src/walk/facade';

const HUB = 60.2;
const SLOT = 13.1;

describe('avenue plan', () => {
  const inside = (block: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) =>
    x > block.minX && x < block.maxX && z > block.minZ && z < block.maxZ;

  it('keeps at least the minimum rings, and grows a ring when doors run out', () => {
    const empty = planAvenues(HUB, 0, SLOT);
    expect(empty.rings).toBe(AVENUES.minRings);
    expect(empty.slots).toHaveLength(0);
    const more = planAvenues(HUB, empty.capacity + 1, SLOT);
    expect(more.rings).toBe(AVENUES.minRings + 1);
    expect(more.radius).toBeGreaterThan(empty.radius);
    expect(planAvenues(HUB, 100_000, SLOT).rings).toBe(AVENUES.maxRings);
  });

  it('lays every block out on one grid: the same square, the same streets between', () => {
    const plan = planAvenues(HUB, 0, SLOT);
    const pitch = AVENUES.blockSize + AVENUES.street;
    for (const block of plan.blocks) {
      expect(block.maxX - block.minX).toBeCloseTo(AVENUES.blockSize);
      expect(block.maxZ - block.minZ).toBeCloseTo(AVENUES.blockSize);
      // Its near walls sit a whole number of blocks and streets out from an avenue's edge.
      for (const near of [Math.min(Math.abs(block.minX), Math.abs(block.maxX)), Math.min(Math.abs(block.minZ), Math.abs(block.maxZ))]) {
        const squares = (near - plan.halfAvenue) / pitch;
        expect(squares).toBeCloseTo(Math.round(squares));
      }
    }
    // No two blocks overlap, and each ring is a square of blocks round the last.
    for (const a of plan.blocks) {
      for (const b of plan.blocks) if (a !== b) expect(inside(a, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)).toBe(false);
    }
    for (let ring = 0; ring < plan.rings; ring++) {
      const blocks = plan.blocks.filter((block) => block.ring === ring);
      const near = ringInner(HUB, ring);
      for (const block of blocks) {
        const out = Math.max(Math.abs(block.minX), Math.abs(block.maxX), Math.abs(block.minZ), Math.abs(block.maxZ));
        expect(out).toBeCloseTo(near + AVENUES.blockSize);
      }
      expect(new Set(blocks.map((block) => `${block.minX},${block.minZ}`)).size).toBe(blocks.length);
    }
  });

  it('runs an avenue straight out of each axial gate, and keeps it clear', () => {
    const plan = planAvenues(HUB, 0, SLOT);
    for (const block of plan.blocks) {
      expect(Math.min(Math.abs(block.minX), Math.abs(block.maxX))).toBeGreaterThanOrEqual(plan.halfAvenue - 1e-6);
      expect(Math.min(Math.abs(block.minZ), Math.abs(block.maxZ))).toBeGreaterThanOrEqual(plan.halfAvenue - 1e-6);
      // Nothing straddles an avenue's centre line.
      expect(Math.sign(block.minX)).toBe(Math.sign(block.maxX));
      expect(Math.sign(block.minZ)).toBe(Math.sign(block.maxZ));
    }
  });

  it('leaves a square plaza round the rotunda', () => {
    const plan = planAvenues(HUB, 0, SLOT);
    expect(ringInner(HUB, 0)).toBeGreaterThanOrEqual(HUB + AVENUES.plaza);
    for (const block of plan.blocks) {
      const out = Math.max(Math.min(Math.abs(block.minX), Math.abs(block.maxX)), Math.min(Math.abs(block.minZ), Math.abs(block.maxZ)));
      expect(out).toBeGreaterThanOrEqual(ringInner(HUB, 0) - 1e-6);
    }
    expect(plan.half).toBeCloseTo(ringInner(HUB, plan.rings));
    expect(plan.radius).toBeCloseTo(plan.half * Math.SQRT2);
  });

  it('gives a door to every world that fits, and keeps each in its block and on its wall as the city grows', () => {
    const small = planAvenues(HUB, 20, SLOT);
    expect(small.slots).toHaveLength(20);
    const large = planAvenues(HUB, small.capacity + 50, SLOT);
    small.slots.forEach((slot, i) => {
      expect([large.slots[i].ring, large.slots[i].block, large.slots[i].face]).toEqual([slot.ring, slot.block, slot.face]);
    });
  });

  it('centres a lone door on its wall, on the side facing the rotunda', () => {
    const plan = planAvenues(HUB, 8, SLOT);
    for (const slot of plan.slots) {
      const block = plan.blocks[slot.block];
      const face = blockFaces(block)[slot.face];
      expect(slot.along).toBeCloseTo(face.length / 2);
      const [mx, mz] = face.at(face.length / 2, 0);
      for (const other of blockFaces(block)) {
        const [ox, oz] = other.at(other.length / 2, 0);
        expect(Math.hypot(mx, mz)).toBeLessThanOrEqual(Math.hypot(ox, oz) + 1e-6);
      }
    }
  });

  it('puts door places in the streets, facing away from their block, clear of each other', () => {
    const plan = planAvenues(HUB, 200, SLOT);
    for (const slot of plan.slots) {
      expect(Math.hypot(slot.facingX, slot.facingZ)).toBeCloseTo(1);
      // The point behind the door is on its block's wall, and a step out from the door is in no block.
      const block = plan.blocks[slot.block];
      const wx = slot.x - slot.facingX * slot.out;
      const wz = slot.z - slot.facingZ * slot.out;
      expect(wx).toBeGreaterThanOrEqual(block.minX - 1e-6);
      expect(wx).toBeLessThanOrEqual(block.maxX + 1e-6);
      expect(wz).toBeGreaterThanOrEqual(block.minZ - 1e-6);
      expect(wz).toBeLessThanOrEqual(block.maxZ + 1e-6);
      for (const other of plan.blocks) expect(inside(other, slot.x + slot.facingX, slot.z + slot.facingZ)).toBe(false);
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

  it('fills the nearest ring first, all the way round', () => {
    const plan = planAvenues(HUB, 1000, SLOT);
    const firstRing = plan.slots.filter((slot) => slot.ring === 0).length;
    expect(plan.slots.slice(0, firstRing).every((slot) => slot.ring === 0)).toBe(true);
    const ringBlocks = plan.blocks.filter((block) => block.ring === 0).length;
    expect(new Set(plan.slots.slice(0, ringBlocks).map((slot) => slot.block)).size).toBe(ringBlocks);
    // A world on each side of the plaza among the first few.
    const sides = new Set(plan.slots.slice(0, 8).map((slot) => `${Math.sign(Math.round(slot.x))},${Math.sign(Math.round(slot.z))}`));
    expect(sides.size).toBeGreaterThanOrEqual(4);
  });
});

describe('block geometry', () => {
  const plan = planAvenues(HUB, 0, SLOT);
  const block = plan.blocks[3];
  const outline = blockOutline(block);
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

describe('storefront geometry', () => {
  const plan = planAvenues(HUB, 30, STOREFRONT_WIDTH);
  const block = plan.blocks[2];

  it('meets each wall at its corners, and puts every door on its own wall', () => {
    const faces = blockFaces(block);
    faces.forEach((face, i) => {
      const next = faces[(i + 1) % faces.length];
      const [ax, az] = face.at(face.length, 0);
      const [bx, bz] = next.at(0, 0);
      expect(Math.hypot(ax - bx, az - bz)).toBeLessThan(1e-6);
    });
    for (const slot of plan.slots) {
      const face = blockFaces(plan.blocks[slot.block])[slot.face];
      const [x, z] = face.at(slot.along, slot.out);
      expect(Math.hypot(x - slot.x, z - slot.z)).toBeLessThan(1e-6);
    }
  });

  it('faces a pier out from its wall', () => {
    for (const face of blockFaces(block)) {
      const pier = faceBox(face, 5, 6, 0, 10, 0, 0.45);
      const position = pier.getAttribute('position');
      const [mx, mz] = face.at(5.5, 0.2);
      for (let i = 0; i < position.count; i += 3) {
        const a = [position.getX(i), position.getY(i), position.getZ(i)];
        const b = [position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)];
        const c = [position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        // Every face points away from the middle of the pier.
        const centre = [(a[0] + b[0] + c[0]) / 3 - mx, (a[1] + b[1] + c[1]) / 3 - 5, (a[2] + b[2] + c[2]) / 3 - mz];
        expect(n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2]).toBeGreaterThan(0);
      }
    }
  });

  it('hangs a sign over every door, as wide as its storefront allows', () => {
    const built = buildAvenues(plan, plan.slots.length);
    expect(built.signs).toHaveLength(plan.slots.length);
    for (const sign of built.signs) {
      expect(sign.aspect).toBeGreaterThan(5);
      expect(sign.geometry.getAttribute('uv')).toBeDefined();
      // In the door's own frame: centred over the doorway, facing out.
      sign.geometry.computeBoundingBox();
      const box = sign.geometry.boundingBox!;
      expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 1);
      expect(box.min.z).toBeGreaterThan(-0.5);
    }
  });
});

describe('the hall dressed as storefronts', () => {
  const radius = 59;
  const gates = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
  const gateHalf = 6.15;
  // A door in the middle of each stretch between two gates, as the hall has them.
  const doors = gates.map((gate) => {
    const angle = gate + Math.PI / 8;
    const toDoor = new Matrix4().makeRotationY(angle + Math.PI).setPosition(Math.sin(angle) * radius, 0, Math.cos(angle) * radius).invert();
    return { angle, toDoor };
  });
  const hall = dressHall(radius, gates, gateHalf, doors, 11.05);

  it('hangs a sign over every door, centred over it, under the screens', () => {
    expect(hall.signs).toHaveLength(doors.length);
    for (const sign of hall.signs) {
      sign.geometry.computeBoundingBox();
      const box = sign.geometry.boundingBox!;
      expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 1);
      expect(box.max.y).toBeLessThan(11.05);
    }
  });

  it('keeps every gate clear: nothing stands in front of an opening below the beam', () => {
    for (const geometry of hall.colliders) {
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const angle = Math.atan2(position.getX(i), position.getZ(i));
        for (const gate of gates) {
          const off = Math.abs(Math.atan2(Math.sin(angle - gate), Math.cos(angle - gate))) * radius;
          expect(off).toBeGreaterThan(gateHalf - 0.01);
        }
      }
    }
  });
});

describe('blocks a building can replace', () => {
  const plan = planAvenues(HUB, 12, STOREFRONT_WIDTH);

  it('gives every world a block of its own', () => {
    const blocks = plan.slots.map((slot) => slot.block);
    expect(new Set(blocks).size).toBe(blocks.length);
    expect(plan.capacity).toBe(plan.blocks.length);
  });

  it("builds a lot's whole block on its own, sign and all, and leaves it out of the city's shared meshes", () => {
    const lots = new Set([0, 2, 5]);
    const shared = buildAvenues(plan, plan.slots.length);
    const built = buildAvenues(plan, plan.slots.length, lots);
    expect([...built.lots.keys()].sort()).toEqual([0, 2, 5]);
    expect(built.signs).toHaveLength(plan.slots.length);
    expect(built.colliders).toHaveLength(shared.colliders.length - lots.size);
    expect(built.solid).toHaveLength(shared.solid.length - lots.size * 3);
    for (const index of lots) {
      const block = plan.blocks[plan.slots[index].block];
      const lot = built.lots.get(index)!;
      expect(lot.width).toBeCloseTo(block.maxX - block.minX);
      expect(lot.depth).toBeCloseTo(block.maxZ - block.minZ);
      // Its collider is the block: as tall, and covering its footprint.
      lot.collider.computeBoundingBox();
      const box = lot.collider.boundingBox!;
      expect(box.max.y).toBeCloseTo(14);
      expect(box.min.x).toBeLessThanOrEqual(block.minX + 1e-6);
      expect(box.max.z).toBeGreaterThanOrEqual(block.maxZ - 1e-6);
      expect(lot.solid.length).toBe(3);
      expect(lot.trim.length).toBeGreaterThan(0);
    }
    expect(shared.lots.size).toBe(0);
  });
});

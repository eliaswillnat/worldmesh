import { describe, expect, it } from 'vitest';
import { AVENUES, blockFaces, planAvenues, ringInner } from '../src/walk/avenuePlan';
import { blockOutline, buildAvenues, dressHall, faceBox, lotCut, notchedOutline, prismRoof, prismWalls } from '../src/walk/avenues';
import { Matrix4 } from 'three';
import { LOT_WIDTH, STOREFRONT_WIDTH } from '../src/walk/facade';

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

describe('building lots', () => {
  const plan = planAvenues(HUB, 12, STOREFRONT_WIDTH);
  /** Even-odd test of (x, z) against a polygon. */
  const within = (polygon: Array<[number, number]>, x: number, z: number) => {
    let inside = false;
    polygon.forEach(([ax, az], i) => {
      const [bx, bz] = polygon[(i + 1) % polygon.length];
      if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    });
    return inside;
  };
  const cutFor = (index: number) => {
    const slot = plan.slots[index];
    const block = plan.blocks[slot.block];
    const face = blockFaces(block)[slot.face];
    return { slot, block, face, cut: lotCut(face.length, slot.along)! };
  };

  it('makes a lot round a door alone in the middle of its wall: a wedge to the middle of the block', () => {
    const cut = lotCut(28, 14)!;
    expect(cut.end - cut.start).toBeCloseTo(LOT_WIDTH);
    expect((cut.start + cut.end) / 2).toBeCloseTo(14);
    // Behind the door it reaches nearly to the middle; at its sides, as far as the diagonals let it.
    expect(cut.depth).toBeCloseTo(13.7);
    expect(cut.back[0][1]).toBeCloseTo(-(cut.start - 0.3));
    expect(cut.taper).toBe(1);
    expect(lotCut(28, 9)).toBeNull();
  });

  it("never lets one lot reach the next wall's, all round a block", () => {
    const block = plan.blocks[0];
    const faces = blockFaces(block);
    const cuts = new Map(faces.map((face) => [face.index, [lotCut(face.length, face.length / 2)!]]));
    const lots = faces.map((face) => {
      const [cut] = cuts.get(face.index)!;
      return [face.at(cut.start, 0), ...cut.back.map(([a, o]) => face.at(a, o)), face.at(cut.end, 0)] as Array<[number, number]>;
    });
    // Every corner of each lot lies outside every other lot.
    lots.forEach((lot, i) =>
      lots.forEach((other, j) => {
        if (i !== j) for (const [x, z] of lot) expect(within(other, x, z)).toBe(false);
      }),
    );
    // What is left of the block holds together: its corners, joined by walls along the diagonals to its middle.
    const footprint = notchedOutline(block, cuts);
    const [cx, cz] = [(block.minX + block.maxX) / 2, (block.minZ + block.maxZ) / 2];
    expect(within(footprint, cx, cz)).toBe(true);
    expect(within(footprint, block.minX + 1, block.minZ + 1)).toBe(true);
    expect(within(footprint, cx - 5, cz - 5)).toBe(true);
    expect(within(footprint, cx, cz - 5)).toBe(false);
  });

  it('cuts each lot into its block, flush in the crown too, and leaves the rest of the block as it was', () => {
    const { slot, block, face, cut } = cutFor(0);
    const notches = new Map([[slot.face, [cut]]]);
    const footprint = notchedOutline(block, notches);
    const crown = notchedOutline(block, notches, 0.5);
    expect(footprint).toHaveLength(9);
    // Inside the lot is outside the block, at its mouth and far back; beside it is still block.
    for (const out of [-0.2, -cut.depth + 0.2]) {
      const [x, z] = face.at(slot.along, out);
      expect(within(footprint, x, z)).toBe(false);
      expect(within(crown, x, z)).toBe(false);
    }
    const [bx, bz] = face.at(cut.start - 0.2, -1);
    expect(within(footprint, bx, bz)).toBe(true);
    const [cx, cz] = face.at(cut.start - 0.2, 0.3);
    expect(within(crown, cx, cz)).toBe(true);
  });

  it('faces the walls round a lot out of the block too', () => {
    const { slot, block, cut } = cutFor(0);
    const footprint = notchedOutline(block, new Map([[slot.face, [cut]]]));
    const walls = prismWalls(footprint, 0, 10);
    const position = walls.getAttribute('position');
    for (let i = 0; i < position.count; i += 3) {
      const a = [position.getX(i), position.getY(i), position.getZ(i)];
      const b = [position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)];
      const c = [position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = u[1] * v[2] - u[2] * v[1];
      const nz = u[0] * v[1] - u[1] * v[0];
      const length = Math.hypot(nx, nz);
      // Just in front of every wall is open ground.
      const mx = (a[0] + b[0] + c[0]) / 3 + (nx / length) * 0.1;
      const mz = (a[2] + b[2] + c[2]) / 3 + (nz / length) * 0.1;
      expect(within(footprint, mx, mz)).toBe(false);
    }
  });

  it('gives each lot a plug that fills its cut, and only lots', () => {
    const lots = new Set([0, 2, 5]);
    const built = buildAvenues(plan, plan.slots.length, lots);
    expect([...built.plugs.keys()].sort()).toEqual([0, 2, 5]);
    expect(built.signs).toHaveLength(plan.slots.length);
    for (const index of lots) {
      const { slot, face, cut } = cutFor(index);
      const plug = built.plugs.get(index)!;
      expect(plug.cut.depth).toBeCloseTo(cut.depth);
      plug.collider.computeBoundingBox();
      const box = plug.collider.boundingBox!;
      // As tall as the block, its front on the wall line (or its cornice just past it), as wide as the lot.
      expect(box.max.y).toBeCloseTo(14);
      const [fx, fz] = face.at(slot.along, 0.5);
      const [nx, nz] = face.normal(slot.along);
      const front = Math.abs(nx) > 0.5 ? (nx > 0 ? box.max.x : box.min.x) : nz > 0 ? box.max.z : box.min.z;
      expect(front).toBeCloseTo(Math.abs(nx) > 0.5 ? fx : fz);
      const along = Math.abs(nx) > 0.5 ? box.max.z - box.min.z : box.max.x - box.min.x;
      expect(along).toBeCloseTo(LOT_WIDTH);
      expect(plug.solid.length).toBeGreaterThan(0);
    }
    expect(buildAvenues(plan, plan.slots.length).plugs.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { blockFaces } from '../src/walk/avenuePlan';
import { BLOCK_HEIGHT, blockOutline, buildAvenues, faceBox, prismRoof, prismWalls } from '../src/walk/avenues';
import { SPAWN_BACK, STREET, planStreet } from '../src/walk/streetPlan';
import { DOOR_HALF_SPAN } from '../src/walk/door';

const inside = (block: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) =>
  x > block.minX + 1e-6 && x < block.maxX - 1e-6 && z > block.minZ + 1e-6 && z < block.maxZ - 1e-6;

describe('street plan', () => {
  it('gives every world a building of its own, with one door each', () => {
    const plan = planStreet(13);
    expect(plan.slots).toHaveLength(13);
    const blocks = plan.slots.map((slot) => slot.block);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('keeps at least the minimum buildings down each side, and grows with the worlds', () => {
    expect(planStreet(0).rows).toBe(STREET.minRows);
    expect(planStreet(0).slots).toHaveLength(0);
    const long = planStreet(STREET.minRows * 2 + 3);
    expect(long.rows).toBe(STREET.minRows + 2);
    expect(long.length).toBeCloseTo(long.rows * STREET.frontage);
    // Both rows, plus the building across the far end.
    expect(long.blocks).toHaveLength(long.rows * 2 + 1);
  });

  it('stands the buildings wall to wall down both sides, with nothing in the street', () => {
    const plan = planStreet(20);
    const sides = [plan.blocks.filter((block) => block.maxX <= 0 && block.maxZ <= 0 && block.minZ >= -plan.length), plan.blocks.filter((block) => block.minX >= 0)];
    for (const row of sides) {
      expect(row).toHaveLength(plan.rows);
      const sorted = [...row].sort((a, b) => b.maxZ - a.maxZ);
      expect(sorted[0].maxZ).toBeCloseTo(0);
      // Each building begins where the one before it ends: no gaps.
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].maxZ).toBeCloseTo(sorted[i - 1].minZ);
    }
    for (const block of plan.blocks) {
      for (let z = -plan.length + 0.5; z < 0; z += 1) expect(inside(block, 0, z)).toBe(false);
      expect(Math.min(Math.abs(block.minX), Math.abs(block.maxX)) >= plan.halfWidth - 1e-6 || block.maxZ <= -plan.length + 1e-6).toBe(true);
    }
  });

  it('closes the far end of the street with a building across it', () => {
    const plan = planStreet(6);
    const end = plan.blocks[plan.blocks.length - 1];
    expect(end.maxZ).toBeCloseTo(-plan.length);
    expect(end.minX).toBeLessThan(-plan.halfWidth);
    expect(end.maxX).toBeGreaterThan(plan.halfWidth);
  });

  it('puts the doors in pairs, facing each other across the street, the first on the left', () => {
    const plan = planStreet(9);
    plan.slots.forEach((slot, i) => {
      expect(Math.hypot(slot.facingX, slot.facingZ)).toBeCloseTo(1);
      expect(slot.facingZ).toBeCloseTo(0);
      // Left side faces +X, right side faces -X.
      expect(Math.sign(slot.x)).toBe(i % 2 === 0 ? -1 : 1);
      expect(Math.sign(slot.facingX)).toBe(i % 2 === 0 ? 1 : -1);
      expect(Math.abs(slot.x)).toBeCloseTo(plan.halfWidth - slot.out);
      // A step out from the door is in the street, in no building.
      for (const block of plan.blocks) expect(inside(block, slot.x + slot.facingX, slot.z)).toBe(false);
    });
    for (let i = 1; i < plan.slots.length; i += 2) expect(plan.slots[i].z).toBeCloseTo(plan.slots[i - 1].z);
  });

  it('centres each door on its building, with room for the doorway', () => {
    const plan = planStreet(8);
    for (const slot of plan.slots) {
      const face = blockFaces(plan.blocks[slot.block])[slot.face];
      expect(slot.along).toBeCloseTo(face.length / 2);
      expect(face.length).toBeGreaterThan(DOOR_HALF_SPAN * 2 + 1);
      const [x, z] = face.at(slot.along, slot.out);
      expect(Math.hypot(x - slot.x, z - slot.z)).toBeLessThan(1e-6);
    }
  });

  it('spawns at the top of the street, looking down it', () => {
    const plan = planStreet(10);
    expect(plan.spawn).toEqual({ x: 0, z: SPAWN_BACK, yaw: 0 });
    for (const block of plan.blocks) expect(inside(block, plan.spawn.x, plan.spawn.z)).toBe(false);
  });

  it('gives the buildings different heights, the same each time', () => {
    const a = planStreet(10).blocks.map((block) => block.height);
    const b = planStreet(10).blocks.map((block) => block.height);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(2);
  });
});

describe('block geometry', () => {
  const plan = planStreet(0);
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
  const plan = planStreet(10);
  const block = plan.blocks[2];

  it('meets each wall at its corners', () => {
    const faces = blockFaces(block);
    faces.forEach((face, i) => {
      const next = faces[(i + 1) % faces.length];
      const [ax, az] = face.at(face.length, 0);
      const [bx, bz] = next.at(0, 0);
      expect(Math.hypot(ax - bx, az - bz)).toBeLessThan(1e-6);
    });
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

  it('builds each building as tall as the plan says, with one collider each', () => {
    const built = buildAvenues(plan, plan.slots.length);
    expect(built.colliders).toHaveLength(plan.blocks.length);
    built.colliders.forEach((collider, i) => {
      collider.computeBoundingBox();
      expect(collider.boundingBox!.max.y).toBeCloseTo(plan.blocks[i].height ?? BLOCK_HEIGHT);
    });
  });
});

import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, ShapeUtils, Vector2 } from 'three';
import { sideAngle, type CityBlock, type CityPlan, type CitySlot } from './avenuePlan';
import { DOOR_HALF_SPAN, DOOR_TOP } from './door';

/**
 * The city of avenues and ring streets (avenuePlan.ts) as geometry, in the
 * rotunda's own vocabulary and nothing more: plain walls, a flat roof under
 * the same cornice as the drum, the light band that runs over the doors, and
 * the same porch behind each world's door as on the rotunda's outer wall.
 */

/** Height of the blocks: well under the rotunda's drum, so the dome still rules the skyline. */
export const BLOCK_HEIGHT = 14;
/** Width of the backing and porch behind each door on an outside wall. */
export const PORCH_WIDTH = DOOR_HALF_SPAN * 2 + 0.8;
/** The cornice round the top: how far it stands out, and how tall it is (as on the drum). */
const CORNICE_OUT = 0.5;
const CORNICE_HEIGHT = 1.2;
/** The light band over the doors, as round the rotunda. */
const BAND_Y = DOOR_TOP + 2.8;
const BAND_HEIGHT = 0.07;
/** Arcs are drawn in steps of this angle. */
const ARC_STEP = Math.PI / 90;

const matrix = new Matrix4();

/**
 * A block's footprint seen from above, as (x, z) points: its inner wall, a
 * side wall along one avenue, its outer wall and a side wall along the next.
 * `grow` pushes every wall out by that much, for trim that stands proud.
 */
export function blockOutline(block: CityBlock, halfAvenue: number, grow = 0): Array<[number, number]> {
  const half = halfAvenue - grow;
  const arc = (r: number, reverse: boolean): Array<[number, number]> => {
    const start = block.from + sideAngle(r, half);
    const end = block.to - sideAngle(r, half);
    const steps = Math.max(2, Math.ceil((end - start) / ARC_STEP));
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const angle = start + ((end - start) * (reverse ? steps - i : i)) / steps;
      points.push([Math.sin(angle) * r, Math.cos(angle) * r]);
    }
    return points;
  };
  return [...arc(block.inner - grow, false), ...arc(block.outer + grow, true)];
}

/** Clockwise seen from above (x right, z down the page), so each wall's front faces out. */
function outward(points: Array<[number, number]>): Array<[number, number]> {
  let area = 0;
  points.forEach(([x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    area += x * nz - nx * z;
  });
  return area > 0 ? [...points].reverse() : points;
}

/**
 * The walls round a footprint, from `bottom` to `top`, facing out. Their
 * winding matters: the walk's collisions push back along the face normal.
 */
export function prismWalls(outline: Array<[number, number]>, bottom: number, top: number): BufferGeometry {
  const points = outward(outline);
  const positions: number[] = [];
  points.forEach(([x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    positions.push(x, bottom, z, nx, bottom, nz, nx, top, nz);
    positions.push(x, bottom, z, nx, top, nz, x, top, z);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A flat lid over a footprint at height `y`, facing up. */
export function prismRoof(outline: Array<[number, number]>, y: number): BufferGeometry {
  const contour = outline.map(([x, z]) => new Vector2(x, z));
  const positions: number[] = [];
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
    const [p, q, r] = [contour[a], contour[b], contour[c]];
    // Facing up when (q - p) × (r - p) points along +Y.
    const up = (q.y - p.y) * (r.x - p.x) - (q.x - p.x) * (r.y - p.y) > 0;
    for (const v of up ? [p, q, r] : [p, r, q]) positions.push(v.x, y, v.y);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A box placed at (x, y, z), turned to face the way `yaw` points. */
function box(width: number, height: number, depth: number, x: number, y: number, z: number, yaw: number): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.applyMatrix4(matrix.makeRotationY(yaw).setPosition(x, y, z));
  return geometry.toNonIndexed();
}

/**
 * The backing, porch canopy and line of light behind a door on an outside
 * wall. (x, z) is the point on the wall's face behind the door, and `yaw`
 * the way the door faces.
 */
export function porch(x: number, z: number, yaw: number): { solid: BufferGeometry[]; glow: BufferGeometry[] } {
  const ahead = (distance: number) => [x + Math.sin(yaw) * distance, z + Math.cos(yaw) * distance] as const;
  const [backX, backZ] = ahead(-0.05);
  const [porchX, porchZ] = ahead(0.55);
  const [lineX, lineZ] = ahead(1.0);
  return {
    solid: [
      box(PORCH_WIDTH, DOOR_TOP + 2.2, 0.5, backX, (DOOR_TOP + 2.2) / 2, backZ, yaw),
      box(PORCH_WIDTH, 0.16, 0.9, porchX, DOOR_TOP + 0.75, porchZ, yaw),
    ],
    glow: [box(PORCH_WIDTH, 0.04, 0.04, lineX, DOOR_TOP + 0.67, lineZ, yaw)],
  };
}

/** The way a door in this slot faces, as a yaw (0 faces +Z). */
export function slotYaw(slot: CitySlot): number {
  return Math.atan2(slot.facingX, slot.facingZ);
}

/**
 * Every block of the plan: walls, cornice and roof (solid), the light band
 * (glow), a porch behind each of the first `doors` slots, and one collider
 * per block, so a step only tests the walls near it.
 */
export function buildAvenues(plan: CityPlan, doors: number): { solid: BufferGeometry[]; glow: BufferGeometry[]; colliders: BufferGeometry[] } {
  const solid: BufferGeometry[] = [];
  const glow: BufferGeometry[] = [];
  const colliders: BufferGeometry[] = [];
  for (const block of plan.blocks) {
    const footprint = blockOutline(block, plan.halfAvenue);
    const walls = prismWalls(footprint, 0, BLOCK_HEIGHT - CORNICE_HEIGHT);
    colliders.push(prismWalls(footprint, 0, BLOCK_HEIGHT));
    solid.push(walls);
    const crown = blockOutline(block, plan.halfAvenue, CORNICE_OUT);
    solid.push(prismWalls(crown, BLOCK_HEIGHT - CORNICE_HEIGHT, BLOCK_HEIGHT));
    solid.push(prismRoof(crown, BLOCK_HEIGHT));
    glow.push(prismWalls(blockOutline(block, plan.halfAvenue, 0.03), BAND_Y, BAND_Y + BAND_HEIGHT));
  }
  for (const slot of plan.slots.slice(0, doors)) {
    const back = porch(slot.x - slot.facingX * slot.out, slot.z - slot.facingZ * slot.out, slotYaw(slot));
    // Untextured, like the blocks they merge with.
    for (const geometry of [...back.solid, ...back.glow]) geometry.deleteAttribute('uv');
    solid.push(...back.solid);
    glow.push(...back.glow);
  }
  return { solid, glow, colliders };
}

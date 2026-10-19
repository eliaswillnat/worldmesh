import { BufferGeometry, Float32BufferAttribute, Matrix4, ShapeUtils, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { arcFace, blockCorners, blockFaces, type CityBlock, type CityPlan, type CitySlot, type WallFace } from './avenuePlan';
import {
  BEAM_DEPTH,
  CORNER_HALF,
  FASCIA_DEPTH,
  PANEL_DEPTH,
  PANEL_INSET,
  PANEL_RIM,
  PIER_DEPTH,
  STREET_LEVELS,
  levelsUnder,
  planFacade,
  type FacadeLevels,
} from './facade';

/**
 * The city's grid of avenues and streets (avenuePlan.ts) as geometry, in the
 * rotunda's own vocabulary: plain walls and a flat roof under the same
 * cornice as the drum, dressed as a row of storefronts (facade.ts). Piers
 * frame each world's door, a fascia over it carries its sign, a beam with
 * the drum's line of light runs the length of every wall, and square piers
 * turn each corner. No windows, no glass.
 */

/** Height of the blocks: well under the rotunda's drum, so the dome still rules the skyline. */
export const BLOCK_HEIGHT = 14;
/** The cornice round the top: how far it stands out, and how tall it is (as on the drum). */
const CORNICE_OUT = 0.5;
const CORNICE_HEIGHT = 1.2;
/** The corner piers stand a little prouder than the beam, which ends against them, and rise to the cornice. */
const CORNER_DEPTH = 0.65;
const CORNER_TOP = BLOCK_HEIGHT - CORNICE_HEIGHT;
/** The sign's face, just in front of the fascia, inset from its edges. */
const SIGN_INSET = 0.12;
/** Arcs are drawn in steps of this angle. */
const ARC_STEP = Math.PI / 90;


/**
 * A block's footprint seen from above, as (x, z) points: its four corners.
 * `grow` pushes every wall out by that much, for trim that stands proud.
 */
export function blockOutline(block: CityBlock, grow = 0): Array<[number, number]> {
  return blockCorners({ ...block, minX: block.minX - grow, maxX: block.maxX + grow, minZ: block.minZ - grow, maxZ: block.maxZ + grow });
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

/**
 * Two triangles from a quad, wound so they face along `normal` (the walk's
 * collisions and the lighting both read the winding).
 */
function quad(positions: number[], a: Vector3, b: Vector3, c: Vector3, d: Vector3, normal: Vector3): void {
  const facing = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).dot(normal) >= 0;
  const corners = facing ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
  for (const v of corners) positions.push(v.x, v.y, v.z);
}

function finish(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Direction of travel along a wall at `along`, as a unit vector. */
function tangent(face: WallFace, along: number): Vector3 {
  const [x0, z0] = face.at(along, 0);
  const [x1, z1] = face.at(along + 0.01, 0);
  return new Vector3(x1 - x0, 0, z1 - z0).normalize();
}

/**
 * A block against a wall, in the wall's own measure: from `start` to `end`
 * along it, `bottom` to `top`, and `back` to `front` out from its face. On a
 * curved wall it bends with the wall. Its back, against the wall, is left
 * open, and so is its underside when it stands on the ground.
 */
export function faceBox(face: WallFace, start: number, end: number, bottom: number, top: number, back: number, front: number): BufferGeometry {
  const steps = face.radius ? Math.max(1, Math.ceil((end - start) / (face.radius * ARC_STEP))) : 1;
  const point = (along: number, y: number, out: number) => {
    const [x, z] = face.at(along, out);
    return new Vector3(x, y, z);
  };
  const positions: number[] = [];
  const up = new Vector3(0, 1, 0);
  const down = new Vector3(0, -1, 0);
  for (let i = 0; i < steps; i++) {
    const s0 = start + ((end - start) * i) / steps;
    const s1 = start + ((end - start) * (i + 1)) / steps;
    const [nx, nz] = face.normal((s0 + s1) / 2);
    quad(positions, point(s0, bottom, front), point(s1, bottom, front), point(s1, top, front), point(s0, top, front), new Vector3(nx, 0, nz));
    quad(positions, point(s0, top, back), point(s1, top, back), point(s1, top, front), point(s0, top, front), up);
    if (bottom > 0.001) quad(positions, point(s0, bottom, back), point(s1, bottom, back), point(s1, bottom, front), point(s0, bottom, front), down);
  }
  for (const [along, sign] of [[start, -1], [end, 1]] as const) {
    quad(
      positions,
      point(along, bottom, back),
      point(along, bottom, front),
      point(along, top, front),
      point(along, top, back),
      tangent(face, along).multiplyScalar(sign),
    );
  }
  return finish(positions);
}

/**
 * The flat face of a sign along a wall, bent with it, with texture
 * coordinates that read left to right for someone facing the wall.
 */
function signFace(face: WallFace, start: number, end: number, bottom: number, top: number, out: number): BufferGeometry {
  const steps = face.radius ? Math.max(1, Math.ceil((end - start) / (face.radius * ARC_STEP))) : 1;
  const middle = (start + end) / 2;
  const [nx, nz] = face.normal(middle);
  // Someone facing the wall has its outward normal at their back; their right is (nz, -nx).
  const forward = tangent(face, middle).dot(new Vector3(nz, 0, -nx)) > 0;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normal = new Vector3(nx, 0, nz);
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const corner = (t: number, y: number) => {
      const [x, z] = face.at(start + (end - start) * t, out);
      return { v: new Vector3(x, y, z), uv: [forward ? t : 1 - t, (y - bottom) / (top - bottom)] };
    };
    const quadCorners = [corner(t0, bottom), corner(t1, bottom), corner(t1, top), corner(t0, top)];
    const [a, b, c] = quadCorners.map((q) => q.v);
    const facing = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).dot(normal) >= 0;
    for (const index of facing ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      const q = quadCorners[index];
      positions.push(q.v.x, q.v.y, q.v.z);
      uvs.push(q.uv[0], q.uv[1]);
    }
  }
  const geometry = finish(positions);
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geometry;
}

/** The way a door in this slot faces, as a yaw (0 faces +Z). */
export function slotYaw(slot: CitySlot): number {
  return Math.atan2(slot.facingX, slot.facingZ);
}

/** The sign over a door: its face, in the door's own frame, and how wide it is for its height. */
export interface StorefrontSign {
  geometry: BufferGeometry;
  aspect: number;
}

/** A door along a dressed wall: how far along it, its index among the signs, and how to carry world space into its own frame. */
export interface FacadeDoor {
  along: number;
  index: number;
  toDoor: Matrix4;
}

/** What dressing walls makes: storefront trim, lines of light, piers to bump into, and each door's sign. */
export interface Dressing {
  trim: BufferGeometry[];
  glow: BufferGeometry[];
  colliders: BufferGeometry[];
  signs: StorefrontSign[];
}

interface DressOptions {
  levels: FacadeLevels;
  /** Run the beam along this wall (false where one beam already rings the whole room). */
  beam: boolean;
  /**
   * Who stands at the wall's two ends: a block's corner pier, built with the
   * corner (dressBlock), or a pier of the wall's own, flanking an opening.
   */
  ends: 'corner' | 'pier';
}

/**
 * One wall dressed as storefronts: piers, the beam with its line of light,
 * a fascia over each door with that door's sign, and a recessed panel in
 * each blank bay. Piers go into `colliders` too, so nobody walks into one.
 */
function dressFace(face: WallFace, doors: FacadeDoor[], options: DressOptions, out: Dressing): void {
  const { levels } = options;
  const layout = planFacade(face.length, doors.map((door) => door.along));
  const end = face.length;
  const solidPier = (start: number, stop: number, top: number, depth: number) => {
    out.trim.push(faceBox(face, start, stop, 0, top, 0, depth));
    out.colliders.push(faceBox(face, start, stop, 0, top, 0, depth));
  };
  for (const pier of layout.piers) {
    // The stretch at each end belongs to the end piers.
    const start = Math.max(pier.start, CORNER_HALF);
    const stop = Math.min(pier.end, end - CORNER_HALF);
    if (stop - start > 0.01) solidPier(start, stop, levels.beamBottom, PIER_DEPTH);
  }
  if (options.ends === 'pier') {
    solidPier(0, CORNER_HALF, levels.beamTop, CORNER_DEPTH);
    solidPier(end - CORNER_HALF, end, levels.beamTop, CORNER_DEPTH);
  }
  if (options.beam) {
    out.trim.push(faceBox(face, CORNER_HALF, end - CORNER_HALF, levels.beamBottom, levels.beamTop, 0, BEAM_DEPTH));
    out.glow.push(faceBox(face, CORNER_HALF, end - CORNER_HALF, levels.beamBottom - 0.05, levels.beamBottom, BEAM_DEPTH - 0.07, BEAM_DEPTH - 0.02));
  }

  for (const front of layout.storefronts) {
    const { start, end: stop } = front.sign;
    const { fasciaBottom: bottom, fasciaTop: top } = levels;
    out.trim.push(faceBox(face, start, stop, bottom, top, 0, FASCIA_DEPTH));
    // Light along the fascia's lower edge, over the doorway.
    out.glow.push(faceBox(face, start + 0.2, stop - 0.2, bottom - 0.04, bottom, FASCIA_DEPTH - 0.07, FASCIA_DEPTH - 0.02));
    const { toDoor, index } = doors[front.door];
    const geometry = signFace(face, start + SIGN_INSET, stop - SIGN_INSET, bottom + SIGN_INSET, top - SIGN_INSET, FASCIA_DEPTH + 0.01);
    // Into the door's frame: it carries the sign, so the sign comes and goes with it.
    geometry.applyMatrix4(toDoor);
    const width = stop - start - SIGN_INSET * 2;
    out.signs[index] = { geometry, aspect: width / (top - bottom - SIGN_INSET * 2) };
  }

  for (const bay of layout.blanks) {
    if (!bay.panel) continue;
    const s0 = bay.start + PANEL_INSET;
    const s1 = bay.end - PANEL_INSET;
    const { panelBottom: y0, panelTop: y1 } = levels;
    out.trim.push(
      faceBox(face, s0, s0 + PANEL_RIM, y0, y1, 0, PANEL_DEPTH),
      faceBox(face, s1 - PANEL_RIM, s1, y0, y1, 0, PANEL_DEPTH),
      faceBox(face, s0 + PANEL_RIM, s1 - PANEL_RIM, y0, y0 + PANEL_RIM, 0, PANEL_DEPTH),
      faceBox(face, s0 + PANEL_RIM, s1 - PANEL_RIM, y1 - PANEL_RIM, y1, 0, PANEL_DEPTH),
    );
  }
}

/** World space into the frame of a door standing in this slot. */
function slotFrame(slot: CitySlot): Matrix4 {
  return new Matrix4().makeRotationY(slotYaw(slot)).setPosition(slot.x, 0, slot.z).invert();
}

/**
 * A block's storefronts on all four walls, and a square pier at each corner
 * that both walls' beams end against.
 */
function dressBlock(faces: WallFace[], doors: Map<number, FacadeDoor[]>, out: Dressing): void {
  for (const face of faces) dressFace(face, doors.get(face.index) ?? [], { levels: STREET_LEVELS, beam: true, ends: 'corner' }, out);
  // Where the walls meet: each wall ends at the corner where the next one begins.
  const corners = faces.map((face, i): [WallFace, number, WallFace, number] => [face, face.length, faces[(i + 1) % faces.length], 0]);
  for (const [a, alongA, b, alongB] of corners) {
    // Along each wall from the corner, and out from both.
    const pier = (face: WallFace, along: number) => {
      const start = along === 0 ? 0 : along - CORNER_HALF;
      return faceBox(face, start, start + CORNER_HALF, 0, CORNER_TOP, 0, CORNER_DEPTH);
    };
    // The square where the two walls' piers would leave a notch, out beyond the corner.
    const [cx, cz] = a.at(alongA, 0);
    const [ax, az] = a.normal(alongA);
    const [bx, bz] = b.normal(alongB);
    const d = CORNER_DEPTH;
    const post: Array<[number, number]> = [
      [cx, cz],
      [cx + ax * d, cz + az * d],
      [cx + (ax + bx) * d, cz + (az + bz) * d],
      [cx + bx * d, cz + bz * d],
    ];
    const parts = [pier(a, alongA), pier(b, alongB), prismWalls(post, 0, CORNER_TOP)];
    out.trim.push(...parts, prismRoof(post, CORNER_TOP));
    out.colliders.push(...parts.map((part) => part.clone()));
  }
}

/**
 * A world's own block, built on its own instead of into the city's shared
 * meshes, so a building of its own can take its place
 * (docs/specs/buildings.md): walls, trim, light and collider as for any
 * block, and the room it leaves, along its door's wall and back from it.
 */
export interface LotBlock {
  width: number;
  depth: number;
  solid: BufferGeometry[];
  trim: BufferGeometry[];
  glow: BufferGeometry[];
  collider: BufferGeometry;
}

/**
 * Every block of the plan: walls, cornice and roof (solid), dressed as
 * storefronts (trim: a shade off the walls, so the piers and panels read
 * in any light), the lines of light (glow), a sign for each of the first `doors`
 * slots, and one collider per block (its walls, roof and piers), so a step only
 * tests what is near it. The blocks of the slots in `lots` come back on their
 * own instead, by slot (LotBlock).
 */
export function buildAvenues(
  plan: CityPlan,
  doors: number,
  lots: ReadonlySet<number> = new Set(),
): {
  solid: BufferGeometry[];
  trim: BufferGeometry[];
  glow: BufferGeometry[];
  colliders: BufferGeometry[];
  signs: StorefrontSign[];
  lots: Map<number, LotBlock>;
} {
  const solid: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glow: BufferGeometry[] = [];
  const colliders: BufferGeometry[] = [];
  const signs: StorefrontSign[] = [];
  const lotBlocks = new Map<number, LotBlock>();
  // The doors on each wall of each block, and which blocks are lots, by their door's slot.
  const byWall = new Map<number, Map<number, FacadeDoor[]>>();
  const lotSlot = new Map<number, number>();
  plan.slots.slice(0, doors).forEach((slot, index) => {
    const walls = byWall.get(slot.block) ?? new Map();
    byWall.set(slot.block, walls);
    walls.set(slot.face, [...(walls.get(slot.face) ?? []), { along: slot.along, index, toDoor: slotFrame(slot) }]);
    if (lots.has(index)) lotSlot.set(slot.block, index);
  });
  plan.blocks.forEach((block, index) => {
    const lot = lotSlot.get(index);
    const own = lot === undefined ? { solid, trim, glow } : { solid: [], trim: [], glow: [] };
    const footprint = blockOutline(block);
    own.solid.push(prismWalls(footprint, 0, BLOCK_HEIGHT - CORNICE_HEIGHT));
    const crown = blockOutline(block, CORNICE_OUT);
    own.solid.push(prismWalls(crown, BLOCK_HEIGHT - CORNICE_HEIGHT, BLOCK_HEIGHT));
    own.solid.push(prismRoof(crown, BLOCK_HEIGHT));
    // The roof too, so someone flying over can land on it.
    const solids: BufferGeometry[] = [prismWalls(footprint, 0, BLOCK_HEIGHT), prismRoof(crown, BLOCK_HEIGHT)];
    const faces = blockFaces(block);
    dressBlock(faces, byWall.get(index) ?? new Map(), { trim: own.trim, glow: own.glow, colliders: solids, signs });
    const collider = mergeAll(solids);
    if (lot === undefined) {
      colliders.push(collider);
    } else {
      const wall = plan.slots[lot].face;
      lotBlocks.set(lot, { ...own, collider, width: faces[wall].length, depth: faces[(wall + 1) % faces.length].length });
    }
  });
  return { solid, trim, glow, colliders, signs, lots: lotBlocks };
}

/**
 * The rotunda's hall dressed the same way: each stretch of its round wall
 * between two gates becomes a row of storefronts round its doors, with a
 * pier flanking each gate, under one beam that rings the whole hall. `gates`
 * are the gates' angles, `gateHalf` half a gate's width along the wall, and
 * each door's `toDoor` carries world space into its frame. Fitted under
 * `ceiling`, where the hall's band of screens begins.
 */
export function dressHall(
  radius: number,
  gates: number[],
  gateHalf: number,
  doors: Array<{ angle: number; toDoor: Matrix4 }>,
  ceiling: number,
): Dressing {
  const levels = levelsUnder(ceiling);
  const out: Dressing = { trim: [], glow: [], colliders: [], signs: [] };
  const step = (Math.PI * 2) / gates.length;
  gates.forEach((gate, i) => {
    const start = gate + gateHalf / radius;
    const face = arcFace(i, radius, start, gate + step - gateHalf / radius, true);
    const own: FacadeDoor[] = [];
    doors.forEach((door, index) => {
      // Round to this stretch of wall, whichever way the angle was given.
      const along = (((door.angle - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * radius;
      if (along < face.length) own.push({ along, index, toDoor: door.toDoor });
    });
    dressFace(face, own, { levels, beam: false, ends: 'pier' }, out);
  });
  // One beam all the way round, over the gates too, with its line of light.
  const ring = arcFace(-1, radius, 0, Math.PI * 2, true);
  out.trim.push(faceBox(ring, 0, ring.length, levels.beamBottom, levels.beamTop, 0, BEAM_DEPTH));
  out.glow.push(faceBox(ring, 0, ring.length, levels.beamBottom - 0.05, levels.beamBottom, BEAM_DEPTH - 0.07, BEAM_DEPTH - 0.02));
  return out;
}

/** One geometry from several with the same attributes. */
function mergeAll(geometries: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(geometries);
  for (const geometry of geometries) geometry.dispose();
  return merged;
}

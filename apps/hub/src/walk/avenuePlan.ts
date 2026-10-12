/**
 * The city round the rotunda, as plain numbers: Paris seen from above. A
 * straight avenue runs out from each of the hall's exits like the spoke of a
 * wheel, and ring streets circle the hall, crossing every avenue. Between two
 * avenues and two ring streets stands a block: plain walls and a flat roof,
 * with world doors along the streets. avenues.ts turns this into geometry.
 *
 * The city grows a ring at a time: as many rings as the worlds need doors,
 * never fewer than `minRings`. A ring keeps its blocks however many rings
 * follow it, and a world keeps its block and wall.
 */

export interface AvenueConfig {
  /** Avenue width, wall to wall: wider than an exit's mouth. */
  avenueWidth: number;
  /** The open street round the rotunda, between its outer wall and the first ring of blocks. */
  plaza: number;
  /** Depth of a ring of blocks, from the street inside it to the street outside. */
  blockDepth: number;
  /** Width of each ring street. */
  ringStreet: number;
  minRings: number;
  maxRings: number;
  /** Bare wall kept at each corner of a block. */
  cornerClear: number;
  /** Bare wall between two doors' porches. */
  doorGap: number;
}

export const AVENUES: AvenueConfig = {
  avenueWidth: 16,
  plaza: 36,
  blockDepth: 28,
  ringStreet: 24,
  minRings: 2,
  maxRings: 6,
  cornerClear: 3,
  doorGap: 4,
};

/** How far a door stands proud of a block's wall: further on a concave face, where the wall curves round its ends. */
const OUT_FLAT = 0.3;
const OUT_CONCAVE = 0.5;

export interface CityBlock {
  /** 0 is the ring nearest the rotunda. */
  ring: number;
  /** The block lies between avenue `sector` and the next one round. */
  sector: number;
  /** Radii of the block's inner and outer walls. */
  inner: number;
  outer: number;
  /** Centre-line angles of the avenues either side (angle 0 faces +Z, as in the hall). */
  from: number;
  to: number;
}

export interface CitySlot {
  /** Where the door stands, and the way it faces (unit vector, out into the street). */
  x: number;
  z: number;
  facingX: number;
  facingZ: number;
  /** How far in front of its wall the door stands. */
  out: number;
  ring: number;
  sector: number;
  /** Which of its block's walls the door is on (see blockFaces), and how far along it from the first corner. */
  face: number;
  along: number;
}

export interface CityPlan {
  rings: number;
  blocks: CityBlock[];
  /** A door for each world, in list order: nearest ring first, spread round every avenue. */
  slots: CitySlot[];
  /** How many doors the city's rings hold in all. */
  capacity: number;
  /** Half an avenue's width: a block's side walls stand this far from the avenue's centre line. */
  halfAvenue: number;
  /** Outer edge of the outermost ring street. */
  radius: number;
}

/** Inner radius of ring `ring`, for a rotunda whose outer wall is at `hub`. */
export function ringInner(hub: number, ring: number, config: AvenueConfig = AVENUES): number {
  return hub + config.plaza + ring * (config.blockDepth + config.ringStreet);
}

/**
 * Angle round the centre of the point at radius `r` on a block's side wall,
 * measured from the avenue's centre line: the wall is straight, a fixed
 * distance from that line, so the angle shrinks further out.
 */
export function sideAngle(r: number, halfAvenue: number): number {
  return Math.asin(Math.min(1, halfAvenue / r));
}

/**
 * One wall of a block, from corner to corner, for whatever stands along it:
 * the doors here, the storefronts in avenues.ts. Positions are given as how
 * far along the wall from its first corner, and how far out in front of it.
 */
export interface WallFace {
  /** 0 the inner wall, 1 the outer wall, 2 the side on avenue `from`, 3 the side on avenue `to`. */
  index: number;
  /** Corner to corner, in metres along the wall. */
  length: number;
  /** Radius of a curved wall; 0 for a straight one. */
  radius: number;
  /** The inner wall curves round towards whoever stands in front of it. */
  concave: boolean;
  /** The point `along` metres from the first corner, `out` metres in front of the wall. */
  at(along: number, out: number): [number, number];
  /** The way out of the wall at `along`, as a unit vector. */
  normal(along: number): [number, number];
}

/**
 * A curved wall of radius `r` from angle `start` to `end` (angle 0 faces +Z),
 * facing the centre when `inward`, away from it otherwise.
 */
export function arcFace(index: number, r: number, start: number, end: number, inward: boolean): WallFace {
  const facing = inward ? -1 : 1;
  return {
    index,
    length: (end - start) * r,
    radius: r,
    concave: inward,
    at: (along, out) => {
      const angle = start + along / r;
      const at = r + facing * out;
      return [Math.sin(angle) * at, Math.cos(angle) * at];
    },
    normal: (along) => {
      const angle = start + along / r;
      return [Math.sin(angle) * facing, Math.cos(angle) * facing];
    },
  };
}

/** A block's four walls: inner, outer, and the sides along the avenues either side. */
export function blockFaces(block: CityBlock, halfAvenue: number): WallFace[] {
  const faces: WallFace[] = [];
  for (const [index, r, inward] of [[0, block.inner, true], [1, block.outer, false]] as const) {
    faces.push(arcFace(index, r, block.from + sideAngle(r, halfAvenue), block.to - sideAngle(r, halfAvenue), inward));
  }
  for (const [index, angle, side] of [[2, block.from, 1], [3, block.to, -1]] as const) {
    // Along the avenue, and across it into the block.
    const ux = Math.sin(angle);
    const uz = Math.cos(angle);
    const nx = Math.cos(angle) * side;
    const nz = -Math.sin(angle) * side;
    const t0 = Math.sqrt(block.inner * block.inner - halfAvenue * halfAvenue);
    const t1 = Math.sqrt(block.outer * block.outer - halfAvenue * halfAvenue);
    faces.push({
      index,
      length: t1 - t0,
      radius: 0,
      concave: false,
      at: (along, out) => {
        const t = t0 + along;
        const across = halfAvenue - out;
        return [ux * t + nx * across, uz * t + nz * across];
      },
      normal: () => [-nx, -nz],
    });
  }
  return faces;
}

/** A stretch of wall that holds doors: where its k doors stand, evenly spread and centred. */
interface Face {
  /** Most doors it holds. */
  capacity: number;
  /** Fill order within a block: nearer the rotunda first. */
  order: number;
  place(count: number): CitySlot[];
}

/** How many doors fit along `length` metres of wall, `slotWidth` each with at least `gap` between. */
function fits(length: number, slotWidth: number, gap: number): number {
  return Math.max(0, Math.floor((length + gap) / (slotWidth + gap)));
}

/** Where `count` doors stand along `length` metres of wall: centred, an equal share of the wall each. */
function spread(length: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => ((i + 0.5) * length) / count);
}

/** The blocks of one ring, and the walls round each that take doors. */
function planRing(hub: number, ring: number, spokes: number, slotWidth: number, config: AvenueConfig): { blocks: CityBlock[]; faces: Face[][] } {
  const half = config.avenueWidth / 2;
  const inner = ringInner(hub, ring, config);
  const outer = inner + config.blockDepth;
  const step = (Math.PI * 2) / spokes;
  const blocks: CityBlock[] = [];
  const faces: Face[][] = [];

  for (let sector = 0; sector < spokes; sector++) {
    const from = sector * step;
    const to = from + step;
    const block: CityBlock = { ring, sector, inner, outer, from, to };
    blocks.push(block);
    // Every wall takes doors, the inner one (facing the rotunda) first.
    const walls: Face[] = blockFaces(block, half).map((face) => {
      const length = face.length - config.cornerClear * 2;
      const out = face.concave ? OUT_CONCAVE : OUT_FLAT;
      const [mx, mz] = face.at(face.length / 2, 0);
      return {
        capacity: fits(length, slotWidth, config.doorGap),
        order: Math.hypot(mx, mz),
        place: (count) =>
          spread(length, count).map((offset) => {
            const along = config.cornerClear + offset;
            const [x, z] = face.at(along, out);
            const [facingX, facingZ] = face.normal(along);
            return { x, z, facingX, facingZ, out, ring, sector, face: face.index, along };
          }),
      };
    });
    faces.push(walls.filter((wall) => wall.capacity > 0).sort((a, b) => a.order - b.order));
  }
  return { blocks, faces };
}

/**
 * The order a ring's door places fill in, as walls: one door for each block
 * in turn, so the ring fills evenly round the wheel, and within a block the
 * wall nearest the rotunda first.
 */
function fillOrder(faces: Face[][]): Face[] {
  const queues = faces.map((walls) => walls.flatMap((wall) => Array.from({ length: wall.capacity }, () => wall)));
  const order: Face[] = [];
  const most = Math.max(0, ...queues.map((queue) => queue.length));
  for (let i = 0; i < most; i++) {
    for (const queue of queues) if (i < queue.length) order.push(queue[i]);
  }
  return order;
}

/**
 * The city round a rotunda whose outer wall is at radius `hub`, with an
 * avenue out of each of its `spokes` exits (the first at angle 0), and doors
 * for `worlds` worlds, each `slotWidth` wide along the wall. Each wall's
 * doors are centred on it: one door stands in the middle, two share it
 * evenly, and so on. A world keeps its block and wall as the city grows;
 * its door moves along the wall only to make room for a new neighbour.
 */
export function planAvenues(hub: number, spokes: number, worlds: number, slotWidth: number, config: AvenueConfig = AVENUES): CityPlan {
  const blocks: CityBlock[] = [];
  const order: Face[] = [];
  let rings = 0;
  while (rings < config.maxRings && (rings < config.minRings || order.length < worlds)) {
    const ring = planRing(hub, rings, spokes, slotWidth, config);
    blocks.push(...ring.blocks);
    order.push(...fillOrder(ring.faces));
    rings++;
  }
  const taken = order.slice(0, worlds);
  const counts = new Map<Face, number>();
  for (const face of taken) counts.set(face, (counts.get(face) ?? 0) + 1);
  const placed = new Map([...counts].map(([face, count]) => [face, face.place(count)]));
  const used = new Map<Face, number>();
  const slots = taken.map((face) => {
    const index = used.get(face) ?? 0;
    used.set(face, index + 1);
    return placed.get(face)![index];
  });
  const radius = rings ? ringInner(hub, rings - 1, config) + config.blockDepth + config.ringStreet : hub + config.plaza;
  return { rings, blocks, slots, capacity: order.length, halfAvenue: config.avenueWidth / 2, radius };
}

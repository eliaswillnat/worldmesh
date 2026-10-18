/**
 * The city round the rotunda, as plain numbers: a grid plan seen from above.
 * The rotunda stands in a square plaza. A straight avenue runs out of each
 * of the hall's four axial exits (north, east, south, west), and streets
 * run parallel to them at an even pitch, so every block is the same square:
 * plain walls and a flat roof, with world doors along the streets.
 * avenues.ts turns this into geometry.
 *
 * The city grows a ring at a time, a ring being the square of blocks just
 * outside the last: as many rings as the worlds need doors, never fewer than
 * `minRings`. A ring keeps its blocks however many rings follow it, and a
 * world keeps its block and wall.
 */

export interface AvenueConfig {
  /** Width of the avenues out of the axial exits, wall to wall: wider than an exit's mouth. */
  avenueWidth: number;
  /** Clear ground at least this deep between the rotunda's outer wall and the first ring of blocks. */
  plaza: number;
  /** Side of a block, corner to corner. */
  blockSize: number;
  /** Width of each street between two blocks. */
  street: number;
  minRings: number;
  maxRings: number;
  /** Bare wall kept at each corner of a block. */
  cornerClear: number;
  /** Bare wall between two doors' porches. */
  doorGap: number;
}

export const AVENUES: AvenueConfig = {
  avenueWidth: 24,
  plaza: 36,
  blockSize: 28,
  street: 16,
  minRings: 2,
  maxRings: 6,
  cornerClear: 3,
  doorGap: 4,
};

/** How far a door stands proud of a block's wall. */
const OUT = 0.3;

export interface CityBlock {
  /** 0 is the ring nearest the rotunda. */
  ring: number;
  /** Where the block stands in its ring, going round from +Z towards +X. */
  index: number;
  /** The block's footprint, wall to wall (angle 0 faces +Z, as in the hall). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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
  /** The door's block, as an index into the plan's blocks. */
  block: number;
  /** Which of its block's walls the door is on (see blockFaces), and how far along it from the first corner. */
  face: number;
  along: number;
}

export interface CityPlan {
  rings: number;
  blocks: CityBlock[];
  /** A door for each world, in list order: nearest ring first, spread round the whole ring. */
  slots: CitySlot[];
  /** How many doors the city's rings hold in all. */
  capacity: number;
  /** Half an avenue's width: the blocks beside an avenue stand this far from its centre line. */
  halfAvenue: number;
  /** Half the side of the square the city fills, to the outer edge of the outermost street. */
  half: number;
  /** Everything in the city lies within this distance of the centre: the corner of that square. */
  radius: number;
}

/** Blocks and street, from one block's near wall to the next one's. */
function pitch(config: AvenueConfig): number {
  return config.blockSize + config.street;
}

/** How many squares of the grid the plaza takes from the middle, each way, so the first ring clears the rotunda by `plaza`. */
function plazaSquares(hub: number, config: AvenueConfig): number {
  return Math.max(0, Math.ceil((hub + config.plaza - config.avenueWidth / 2) / pitch(config) - 1e-9));
}

/** Distance from the centre lines to the near walls of ring `ring`, for a rotunda whose outer wall is at `hub`. */
export function ringInner(hub: number, ring: number, config: AvenueConfig = AVENUES): number {
  return config.avenueWidth / 2 + (plazaSquares(hub, config) + ring) * pitch(config);
}

/**
 * One wall of a block, from corner to corner, for whatever stands along it:
 * the doors here, the storefronts in avenues.ts. Positions are given as how
 * far along the wall from its first corner, and how far out in front of it.
 */
export interface WallFace {
  /** Which wall of its block (see blockFaces), or of the hall. */
  index: number;
  /** Corner to corner, in metres along the wall. */
  length: number;
  /** Radius of a curved wall; 0 for a straight one. */
  radius: number;
  /** The wall curves round towards whoever stands in front of it. */
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

/** The four corners of a block, in the order its walls run between them. */
export function blockCorners(block: CityBlock): Array<[number, number]> {
  return [
    [block.minX, block.minZ],
    [block.maxX, block.minZ],
    [block.maxX, block.maxZ],
    [block.minX, block.maxZ],
  ];
}

/**
 * A block's four walls, each from one corner to the next (blockCorners), so
 * wall i ends where wall i + 1 begins: 0 faces -Z, 1 faces +X, 2 faces +Z,
 * 3 faces -X.
 */
export function blockFaces(block: CityBlock): WallFace[] {
  const corners = blockCorners(block);
  return corners.map(([x0, z0], index) => {
    const [x1, z1] = corners[(index + 1) % corners.length];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / length;
    const uz = (z1 - z0) / length;
    // Going round this way, out of the block is to the right of the way along.
    const nx = uz;
    const nz = -ux;
    return {
      index,
      length,
      radius: 0,
      concave: false,
      at: (along, out) => [x0 + ux * along + nx * out, z0 + uz * along + nz * out],
      normal: () => [nx, nz],
    };
  });
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

/** Near and far wall of the `square`th square out from a centre line, on the side given by `sign`. */
function span(square: number, sign: 1 | -1, config: AvenueConfig): [number, number] {
  const near = config.avenueWidth / 2 + square * pitch(config);
  const far = near + config.blockSize;
  return sign > 0 ? [near, far] : [-far, -near];
}

/** The blocks of one ring, and the walls round each that take doors. `first` is the index the ring's first block gets in the plan. */
function planRing(hub: number, ring: number, first: number, slotWidth: number, config: AvenueConfig): { blocks: CityBlock[]; faces: Face[][] } {
  const out = plazaSquares(hub, config) + ring;
  // Every square of the grid this many out from the centre lines, one way or the other.
  const squares: Array<[number, number]> = [];
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      for (let k = 0; k <= out; k++) squares.push([sx * (out + 0.5), sz * (k + 0.5)]);
      for (let k = 0; k < out; k++) squares.push([sx * (k + 0.5), sz * (out + 0.5)]);
    }
  }
  const round = (x: number, z: number) => (Math.atan2(x, z) + Math.PI * 2) % (Math.PI * 2);
  squares.sort((a, b) => round(...a) - round(...b));

  const blocks: CityBlock[] = [];
  const faces: Face[][] = [];
  squares.forEach(([gx, gz], index) => {
    const [minX, maxX] = span(Math.floor(Math.abs(gx)), gx > 0 ? 1 : -1, config);
    const [minZ, maxZ] = span(Math.floor(Math.abs(gz)), gz > 0 ? 1 : -1, config);
    const block: CityBlock = { ring, index, minX, maxX, minZ, maxZ };
    blocks.push(block);
    // Every wall takes doors, those facing the rotunda first.
    const walls: Face[] = blockFaces(block).map((face) => {
      const length = face.length - config.cornerClear * 2;
      const [mx, mz] = face.at(face.length / 2, 0);
      return {
        capacity: fits(length, slotWidth, config.doorGap),
        order: Math.hypot(mx, mz),
        place: (count) =>
          spread(length, count).map((offset) => {
            const along = config.cornerClear + offset;
            const [x, z] = face.at(along, OUT);
            const [facingX, facingZ] = face.normal(along);
            return { x, z, facingX, facingZ, out: OUT, ring, block: first + index, face: face.index, along };
          }),
      };
    });
    faces.push(walls.filter((wall) => wall.capacity > 0).sort((a, b) => a.order - b.order));
  });
  return { blocks, faces };
}

/**
 * A round of `count` blocks, given in order round the ring, visited so each
 * next one is as far as can be from those before: halfway round, then the
 * quarters, the eighths, and so on, taking the nearest block not yet taken.
 */
function spreadOrder(count: number): number[] {
  const order: number[] = [];
  const taken = new Set<number>();
  for (let k = 0; order.length < count; k++) {
    // k's binary digits mirrored past the point: 0, 1/2, 1/4, 3/4, 1/8...
    let at = 0;
    for (let bit = 0.5, n = k; n; bit /= 2, n >>= 1) if (n & 1) at += bit;
    let best = -1;
    for (let i = 0; i < count; i++) {
      if (taken.has(i)) continue;
      const off = (i + 0.5) / count - at;
      const gap = Math.min(Math.abs(off), 1 - Math.abs(off));
      const bestOff = best < 0 ? 0 : (best + 0.5) / count - at;
      if (best < 0 || gap < Math.min(Math.abs(bestOff), 1 - Math.abs(bestOff)) - 1e-9) best = i;
    }
    taken.add(best);
    order.push(best);
  }
  return order;
}

/**
 * The order a ring's door places fill in, as walls: one door for each block
 * in turn, spread so the first few already stand all round the plaza, and
 * within a block the wall nearest the rotunda first.
 */
function fillOrder(faces: Face[][]): Face[] {
  const queues = spreadOrder(faces.length).map((block) => faces[block].flatMap((wall) => Array.from({ length: wall.capacity }, () => wall)));
  const order: Face[] = [];
  const most = Math.max(0, ...queues.map((queue) => queue.length));
  for (let i = 0; i < most; i++) {
    for (const queue of queues) if (i < queue.length) order.push(queue[i]);
  }
  return order;
}

/**
 * The city round a rotunda whose outer wall is at radius `hub`, with doors
 * for `worlds` worlds, each `slotWidth` wide along the wall. Each wall's
 * doors are centred on it: one door stands in the middle, two share it
 * evenly, and so on. A world keeps its block and wall as the city grows;
 * its door moves along the wall only to make room for a new neighbour.
 */
export function planAvenues(hub: number, worlds: number, slotWidth: number, config: AvenueConfig = AVENUES): CityPlan {
  const blocks: CityBlock[] = [];
  const order: Face[] = [];
  let rings = 0;
  while (rings < config.maxRings && (rings < config.minRings || order.length < worlds)) {
    const ring = planRing(hub, rings, blocks.length, slotWidth, config);
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
  const half = rings ? ringInner(hub, rings, config) : hub + config.plaza;
  return { rings, blocks, slots, capacity: order.length, halfAvenue: config.avenueWidth / 2, half, radius: half * Math.SQRT2 };
}

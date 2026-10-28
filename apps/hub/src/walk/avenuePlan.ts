/**
 * The shapes the lobby's buildings are planned in, as plain numbers seen
 * from above: rectangular blocks, the walls round each, and the door places
 * along them. streetPlan.ts lays them out; avenues.ts turns them into
 * geometry.
 */

/** How far a door stands proud of a block's wall. */
export const DOOR_OUT = 0.3;

export interface CityBlock {
  /** Always 0: the lobby is one street. */
  ring: number;
  /** Where the block stands in the plan. */
  index: number;
  /** How tall it stands; the default height (avenues.ts) when left out. */
  height?: number;
  /** The block's footprint, wall to wall (seen from above). */
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
  /** A door for each world, in list order. */
  slots: CitySlot[];
  /** How many doors the plan holds in all. */
  capacity: number;
  /** Half the street's width: the blocks beside it stand this far from its centre line. */
  halfAvenue: number;
  /** How far the plan reaches from the start of the street. */
  half: number;
  /** Everything in the plan lies within this distance of the start of the street. */
  radius: number;
}

/**
 * One wall of a block, from corner to corner, for whatever stands along it:
 * the doors here, the storefronts in avenues.ts. Positions are given as how
 * far along the wall from its first corner, and how far out in front of it.
 */
export interface WallFace {
  /** Which wall of its block (see blockFaces). */
  index: number;
  /** Corner to corner, in metres along the wall. */
  length: number;
  /** The point `along` metres from the first corner, `out` metres in front of the wall. */
  at(along: number, out: number): [number, number];
  /** The way out of the wall at `along`, as a unit vector. */
  normal(along: number): [number, number];
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
      at: (along, out) => [x0 + ux * along + nx * out, z0 + uz * along + nz * out],
      normal: () => [nx, nz],
    };
  });
}

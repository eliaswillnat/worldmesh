/**
 * The lobby as one street, as plain numbers: a straight street with a row
 * of buildings down each side, standing wall to wall with no gaps. Every
 * building is one world's, with its door in the middle of its front, so the
 * doors face each other across the street. A building closes the far end,
 * and the visitor arrives at the near end, looking down the street.
 *
 * The street runs from z = 0 towards -Z, centred on x = 0. The first world
 * is on the left, the second opposite it on the right, and so on. avenues.ts
 * turns this into geometry, the same storefronts as before.
 */

import { blockFaces, DOOR_OUT, type CityBlock, type CityPlan, type CitySlot } from './avenuePlan';

export interface StreetConfig {
  /** Wall to wall across the street. */
  width: number;
  /** Each building's front, along the street. */
  frontage: number;
  /** How far each building reaches back from the street. */
  depth: number;
  /** Buildings on each side, at least, however few worlds there are. */
  minRows: number;
}

export const STREET: StreetConfig = {
  width: 22,
  frontage: 18,
  depth: 16,
  minRows: 4,
};

/** Where the visitor arrives: this far before the first buildings, in the middle of the street. */
export const SPAWN_BACK = 6;

export interface StreetPlan extends CityPlan {
  /** Buildings down each side. */
  rows: number;
  /** From the start of the street to the face of the building at its far end. */
  length: number;
  /** Half the street's width, wall to wall. */
  halfWidth: number;
  /** Where the visitor arrives (feet), facing down the street (yaw 0 looks along -Z). */
  spawn: { x: number; z: number; yaw: number };
}

/** The street with a door for each of `worlds` worlds. */
export function planStreet(worlds: number, config: StreetConfig = STREET): StreetPlan {
  const rows = Math.max(config.minRows, Math.ceil(worlds / 2));
  const half = config.width / 2;
  const blocks: CityBlock[] = [];
  const slots: CitySlot[] = [];
  for (let row = 0; row < rows; row++) {
    const maxZ = -row * config.frontage;
    const minZ = maxZ - config.frontage;
    for (const side of [0, 1] as const) {
      const left = side === 0;
      const index = blocks.length;
      const block = {
        ring: 0,
        index,
        minX: left ? -half - config.depth : half,
        maxX: left ? -half : half + config.depth,
        minZ,
        maxZ,
      };
      blocks.push(block);
      if (row * 2 + side >= worlds) continue;
      // The wall facing the street: +X on the left, -X on the right (blockFaces).
      const face = blockFaces(block)[left ? 1 : 3];
      const along = face.length / 2;
      const [x, z] = face.at(along, DOOR_OUT);
      const [facingX, facingZ] = face.normal(along);
      slots.push({ x, z, facingX, facingZ, out: DOOR_OUT, ring: 0, block: index, face: face.index, along });
    }
  }
  const length = rows * config.frontage;
  // Across the far end, as wide as both rows: the street stops at its blank front.
  blocks.push({
    ring: 0,
    index: blocks.length,
    minX: -half - config.depth,
    maxX: half + config.depth,
    minZ: -length - config.depth,
    maxZ: -length,
  });
  const reach = Math.hypot(half + config.depth, length + config.depth);
  return {
    rings: 1,
    rows,
    blocks,
    slots,
    capacity: rows * 2,
    halfAvenue: half,
    half: reach,
    radius: reach,
    length,
    halfWidth: half,
    spawn: { x: 0, z: SPAWN_BACK, yaw: 0 },
  };
}

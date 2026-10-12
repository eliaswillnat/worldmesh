/**
 * The city round the rotunda, as plain numbers: Paris seen from above. A
 * straight avenue runs out from each of the hall's exits like the spoke of a
 * wheel, and ring streets circle the hall, crossing every avenue. Between two
 * avenues and two ring streets stands a block: plain walls and a flat roof,
 * with world doors along the streets. avenues.ts turns this into geometry.
 *
 * The city grows a ring at a time: as many rings as the worlds need doors,
 * never fewer than `minRings`. A ring keeps its blocks and door places however
 * many rings follow it, so a world's door stays where it was.
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
  plaza: 18,
  blockDepth: 28,
  ringStreet: 12,
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
}

export interface CityPlan {
  rings: number;
  blocks: CityBlock[];
  /** Door places, in the order worlds fill them: nearest ring first, spread round every avenue. */
  slots: CitySlot[];
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

/** Evenly spaced door centres along `length` metres of wall, `slotWidth` each with `gap` between. */
function spread(length: number, slotWidth: number, gap: number): number[] {
  const count = Math.floor((length + gap) / (slotWidth + gap));
  return Array.from({ length: Math.max(0, count) }, (_, i) => ((i + 0.5) * length) / count);
}

/** The blocks of one ring, and their door places in fill order. */
function planRing(hub: number, ring: number, spokes: number, slotWidth: number, config: AvenueConfig): { blocks: CityBlock[]; slots: CitySlot[] } {
  const half = config.avenueWidth / 2;
  const inner = ringInner(hub, ring, config);
  const outer = inner + config.blockDepth;
  const step = (Math.PI * 2) / spokes;
  const blocks: CityBlock[] = [];
  const bySector: Array<Array<CitySlot & { order: number }>> = [];

  for (let sector = 0; sector < spokes; sector++) {
    const from = sector * step;
    const to = from + step;
    blocks.push({ ring, sector, inner, outer, from, to });
    const slots: Array<CitySlot & { order: number }> = [];

    // Along the inner and outer walls, facing the ring streets.
    for (const [r, inward] of [[inner, true], [outer, false]] as const) {
      const start = from + sideAngle(r, half);
      const length = (to - sideAngle(r, half) - start) * r - config.cornerClear * 2;
      const out = inward ? OUT_CONCAVE : OUT_FLAT;
      for (const along of spread(length, slotWidth, config.doorGap)) {
        const angle = start + (config.cornerClear + along) / r;
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const facing = inward ? -1 : 1;
        const at = r + facing * out;
        slots.push({ x: sin * at, z: cos * at, facingX: sin * facing, facingZ: cos * facing, out, ring, sector, order: r });
      }
    }

    // Along the side walls, facing the avenues either side.
    for (const [angle, side] of [[from, 1], [to, -1]] as const) {
      // Along the avenue, and across it into the block.
      const ux = Math.sin(angle);
      const uz = Math.cos(angle);
      const nx = Math.cos(angle) * side;
      const nz = -Math.sin(angle) * side;
      const t0 = Math.sqrt(inner * inner - half * half);
      const t1 = Math.sqrt(outer * outer - half * half);
      const length = t1 - t0 - config.cornerClear * 2;
      for (const along of spread(length, slotWidth, config.doorGap)) {
        const t = t0 + config.cornerClear + along;
        const across = half - OUT_FLAT;
        slots.push({
          x: ux * t + nx * across,
          z: uz * t + nz * across,
          facingX: -nx,
          facingZ: -nz,
          out: OUT_FLAT,
          ring,
          sector,
          order: t,
        });
      }
    }
    bySector.push(slots.sort((a, b) => a.order - b.order));
  }

  // Take one door from each block in turn, so the ring fills evenly round the wheel.
  const slots: CitySlot[] = [];
  const most = Math.max(0, ...bySector.map((list) => list.length));
  for (let i = 0; i < most; i++) {
    for (const list of bySector) {
      if (i >= list.length) continue;
      const { order: _order, ...slot } = list[i];
      slots.push(slot);
    }
  }
  return { blocks, slots };
}

/**
 * The city round a rotunda whose outer wall is at radius `hub`, with an
 * avenue out of each of its `spokes` exits (the first at angle 0), and room
 * for `worlds` doors, each `slotWidth` wide along the wall.
 */
export function planAvenues(hub: number, spokes: number, worlds: number, slotWidth: number, config: AvenueConfig = AVENUES): CityPlan {
  const blocks: CityBlock[] = [];
  const slots: CitySlot[] = [];
  let rings = 0;
  while (rings < config.maxRings && (rings < config.minRings || slots.length < worlds)) {
    const ring = planRing(hub, rings, spokes, slotWidth, config);
    blocks.push(...ring.blocks);
    slots.push(...ring.slots);
    rings++;
  }
  const radius = rings ? ringInner(hub, rings - 1, config) + config.blockDepth + config.ringStreet : hub + config.plaza;
  return { rings, blocks, slots, halfAvenue: config.avenueWidth / 2, radius };
}

/**
 * Where the city's towers stand and which screens they carry, as plain
 * numbers. city.ts turns this into geometry; workers/ads uses the same plan to
 * know which billboard IDs exist. No three.js and no DOM, so both can import it.
 *
 * Every screen is a billboard with a permanent ID such as `f07-main`: ring
 * (front/back), tower number, and which screen on that tower. A tower keeps
 * its number, shape and screens however large the citadel grows, so an
 * advertisement booked for `f07-main` stays on the same screen.
 */

/** Clear space between the citadel and the first ring of towers. */
export const PLAZA_DEPTH = 22;
/** How far the second, taller ring stands behind the first. */
export const BACK_RING_OFFSET = 34;

const FRONT_SPACING = 17;
const BACK_SPACING = 20;
const BACK_SCALE = 1.7;

/**
 * Towers drawn from the city's single seeded sequence: exactly what the
 * smallest citadel gets. They keep that sequence so the skyline never changes;
 * a larger citadel adds towers after them, each seeded by its own ID.
 */
const BASE_TOWERS: Record<Ring, number> = { front: 15, back: 24 };
/** Upper bound on towers per ring, for listing every billboard ID that can ever exist. */
const MAX_TOWERS = 96;
const SEED = 0x5eed;

export type Ring = 'front' | 'back';
export type ScreenSlot = 'main' | 'low' | 'wing' | 'upper' | 'lower';

export interface ScreenPlan {
  id: string;
  ring: Ring;
  tower: number;
  slot: ScreenSlot;
  /** Wrapped around a round tower rather than flat. */
  curved: boolean;
  /** Landscape (2:1) rather than portrait. */
  wide: boolean;
  width: number;
  height: number;
  /**
   * Flat screens: centre of the screen in the tower's frame, which faces the
   * citadel along +Z. Curved screens: centre of the cylinder they wrap, whose
   * surface faces +Z at `radius`.
   */
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface BlockShape {
  kind: 'block';
  w: number;
  h: number;
  d: number;
  crownH: number;
  /** Which front corner the vertical fin runs up. */
  fin: -1 | 1;
  /** Which side the wing sits on. */
  side: -1 | 1;
  wingW: number;
  wingH: number;
  /** A low wide screen in front of the base, instead of a screen on the wing. */
  low: boolean;
}

export interface RoundShape {
  kind: 'round';
  r: number;
  h: number;
}

export interface TowerPlan {
  ring: Ring;
  index: number;
  /** Around the citadel; 0 is the gate (+Z). */
  angle: number;
  /** From the ring's line to the tower's centre. */
  offset: number;
  scale: number;
  /** In the first ring: you can walk up to it, so it gets colliders. */
  reachable: boolean;
  shape: BlockShape | RoundShape;
  screens: ScreenPlan[];
}

/** Small seeded generator so the skyline is the same for everyone. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Distance from the citadel's centre to each ring's line. */
export function ringDistance(ring: Ring, citadelRadius: number): number {
  const front = citadelRadius + PLAZA_DEPTH;
  return ring === 'front' ? front : front + BACK_RING_OFFSET;
}

function towerCount(ring: Ring, citadelRadius: number): number {
  const spacing = ring === 'front' ? FRONT_SPACING : BACK_SPACING;
  const fits = Math.round((Math.PI * 2 * ringDistance(ring, citadelRadius)) / spacing);
  return Math.min(MAX_TOWERS, Math.max(BASE_TOWERS[ring], fits));
}

/**
 * Lay out two rings of towers around a citadel whose outer wall is
 * `citadelRadius` wide. The gate faces +Z, so the first ring leaves the
 * avenue in front of it open.
 */
export function planCity(citadelRadius: number): TowerPlan[] {
  const counts = { front: towerCount('front', citadelRadius), back: towerCount('back', citadelRadius) };
  const shared = random(SEED);
  const towers: TowerPlan[] = [];
  for (const ring of ['front', 'back'] as const) {
    for (let i = 0; i < BASE_TOWERS[ring]; i++) towers.push(planTower(ring, i, counts[ring], shared));
  }
  for (const ring of ['front', 'back'] as const) {
    for (let i = BASE_TOWERS[ring]; i < counts[ring]; i++) towers.push(planTower(ring, i, counts[ring], extraRandom(ring, i)));
  }
  return towers;
}

let catalog: Map<string, ScreenPlan> | null = null;

/** Every billboard that exists at any citadel size, by ID. */
export function billboardCatalog(): Map<string, ScreenPlan> {
  if (catalog) return catalog;
  catalog = new Map();
  const shared = random(SEED);
  const add = (tower: TowerPlan) => tower.screens.forEach((screen) => catalog!.set(screen.id, screen));
  for (const ring of ['front', 'back'] as const) {
    for (let i = 0; i < BASE_TOWERS[ring]; i++) add(planTower(ring, i, MAX_TOWERS, shared));
  }
  for (const ring of ['front', 'back'] as const) {
    for (let i = BASE_TOWERS[ring]; i < MAX_TOWERS; i++) add(planTower(ring, i, MAX_TOWERS, extraRandom(ring, i)));
  }
  return catalog;
}

export function isBillboardId(id: unknown): id is string {
  return typeof id === 'string' && /^[fb]\d{2}-(main|low|wing|upper|lower)$/.test(id) && billboardCatalog().has(id);
}

/** "Front ring · tower 8 · main screen (portrait)" */
export function describeBillboard(id: string): string {
  const plan = billboardCatalog().get(id);
  if (!plan) return id;
  const slot = { main: 'main screen', low: 'low street screen', wing: 'wing screen', upper: 'upper screen', lower: 'lower screen' }[plan.slot];
  return `${plan.ring === 'front' ? 'Front ring' : 'Back ring'} · tower ${plan.tower + 1} · ${slot} (${plan.wide ? 'landscape 2:1' : 'portrait 1:2'}${plan.curved ? ', curved' : ''})`;
}

function extraRandom(ring: Ring, index: number): () => number {
  return random(hash(`${ring}:${index}`) ^ SEED);
}

function billboardId(ring: Ring, tower: number, slot: ScreenSlot): string {
  return `${ring === 'front' ? 'f' : 'b'}${String(tower).padStart(2, '0')}-${slot}`;
}

function planTower(ring: Ring, index: number, count: number, rand: () => number): TowerPlan {
  // Half a slot off so the gate (angle 0) looks down a gap between towers.
  const angle = ((index + 0.5) / count) * Math.PI * 2 + (rand() - 0.5) * 0.08;
  const depth = 7 + rand() * 3;
  const offset = depth / 2 + rand() * 3;
  const scale = ring === 'front' ? 1 : BACK_SCALE;
  const round = rand() < 0.25;
  const shape = round ? planRound(rand, scale) : planBlock(rand, scale, depth);
  const screen = (slot: ScreenSlot, fields: Omit<ScreenPlan, 'id' | 'ring' | 'tower' | 'slot'>): ScreenPlan => ({
    id: billboardId(ring, index, slot),
    ring,
    tower: index,
    slot,
    ...fields,
  });

  const screens: ScreenPlan[] = [];
  if (shape.kind === 'round') {
    const { r, h } = shape;
    // Two screens stacked on the side facing the plaza.
    const width = r * 1.5;
    const height = width * 2;
    const upperY = h - 2 - height / 2;
    const curved = { curved: true, wide: false, width, x: 0, z: 0, radius: r + 0.04 };
    screens.push(screen('upper', { ...curved, height, y: upperY }));
    if (upperY - height > 2) {
      screens.push(screen('lower', { ...curved, height: height * 0.75, y: upperY - height / 2 - 1 - height * 0.375 }));
    }
  } else {
    const { w, h, d, side, wingW, wingH } = shape;
    const width = w - 1.8;
    const height = Math.min(width * 2, h - 5);
    screens.push(screen('main', { curved: false, wide: false, width, height, x: 0, y: h - 2 - height / 2, z: d / 2 + 0.27, radius: 0 }));
    const wingX = side * (w / 2 + wingW / 2 - 0.4);
    if (shape.low) {
      const lowW = w + wingW - 1.5;
      const lowH = lowW / 2;
      screens.push(screen('low', { curved: false, wide: true, width: lowW, height: lowH, x: wingX / 2, y: 0.8 + lowH / 2, z: d / 2 + 1.82, radius: 0 }));
    } else if (wingH > 11) {
      const wingScreenW = wingW - 1;
      const wingScreenH = Math.min(wingScreenW * 2, wingH - 3);
      screens.push(
        screen('wing', { curved: false, wide: false, width: wingScreenW, height: wingScreenH, x: wingX, y: wingH - 1.5 - wingScreenH / 2, z: d / 2 + 0.52, radius: 0 }),
      );
    }
  }

  return { ring, index, angle, offset, scale, reachable: ring === 'front', shape, screens };
}

/** White stacked blocks: main tower, setback crown, side wing and plinth. */
function planBlock(rand: () => number, scale: number, depth: number): BlockShape {
  const w = 6 + rand() * 3;
  const h = (16 + rand() * 16) * scale;
  const crownH = 3 + rand() * 6 * scale;
  const fin = rand() < 0.5 ? -1 : 1;
  const side = rand() < 0.5 ? -1 : 1;
  const wingW = 3.5 + rand() * 2;
  const wingH = (9 + rand() * 8) * Math.min(scale, 1.3);
  const low = rand() < 0.45;
  return { kind: 'block', w, h, d: depth, crownH, fin, side, wingW, wingH, low };
}

/** A white drum. */
function planRound(rand: () => number, scale: number): RoundShape {
  const r = 4 + rand() * 1.5;
  const h = (20 + rand() * 14) * scale;
  return { kind: 'round', r, h };
}

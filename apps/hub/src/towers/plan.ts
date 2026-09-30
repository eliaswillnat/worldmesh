import type { Band, PlacementSlot, Strategy } from '../discovery/placement';
import { unitHash } from '../discovery/random';
import type { Category, CategoryRegistry } from '../worlds/categories';
import type { CityConfig } from './config';

/**
 * The city as plain numbers: where each tower stands, how many floors it
 * has, what kind each floor is, where every door, lift and bridge sits, and
 * which placement slot each door is. No three.js and no DOM: rendering reads
 * this plan, placement reads its slots, and tests read both.
 *
 * Angles around a tower use atan2(dx, dz): 0 points along +Z, and a point
 * at angle a on radius r is (cx + sin a · r, cz + cos a · r).
 */

export interface CityData {
  towers: { category: string; angle?: number }[];
  bridges: { from: string; to: string; level: number }[];
}

export type FloorKind = 'ground' | 'standard' | 'transfer' | 'summit';

export interface WallPosition {
  kind: 'door' | 'lift' | 'entrance' | 'bridge';
  angle: number;
  /** Half the angle the feature takes up along the wall, margins included. */
  halfWidth: number;
  /** Doors: their placement slot. */
  slotId?: string;
  doorIndex?: number;
  liftIndex?: number;
  bridgeId?: string;
}

export interface FloorPlan {
  index: number;
  kind: FloorKind;
  band: Band;
  /** Height of the walking surface. */
  y: number;
  /** Signage for the floor, e.g. "TRENDING NOW". */
  title: string;
  /** Bridge level number (1, 2, ...) on transfer floors. */
  bridgeLevel: number | null;
  positions: WallPosition[];
  slots: PlacementSlot[];
}

/** A hole through the tower's outer wall (entrance or bridge mouth). */
export interface Opening {
  angle: number;
  /** Half the opening's width in metres (the angle it takes depends on the radius). */
  halfSpan: number;
  bottom: number;
  top: number;
}

export interface TowerPlan {
  id: string;
  category: Category;
  center: { x: number; z: number };
  /** Angle (around the tower) that faces the citadel. */
  frontAngle: number;
  floorCount: number;
  floors: FloorPlan[];
  liftAngles: number[];
  openings: Opening[];
  bridges: BridgePlan[];
}

export interface BridgePlan {
  id: string;
  from: string;
  to: string;
  level: number;
  floor: number;
  y: number;
  /** Deck ends, just inside each tower's wall. */
  start: { x: number; z: number };
  end: { x: number; z: number };
  /** Angle of the bridge around `from`; the angle around `to` is this + π. */
  heading: number;
  length: number;
}

export interface CityPlan {
  towers: TowerPlan[];
  bridges: BridgePlan[];
  ringRadius: number;
  /** The walkable ground ends here. */
  groundRadius: number;
  tower(id: string): TowerPlan | undefined;
}

/** Placement strategies per band, cycled by door index. */
const BAND_STRATEGIES: Record<Exclude<Band, 'regular'>, Strategy[]> = {
  lower: ['trending', 'popular', 'trending', 'fresh', 'rising', 'trending', 'popular', 'fresh'],
  middle: ['rising', 'fresh', 'featured', 'discovery', 'rising', 'fresh', 'featured', 'rising'],
  // One explicit sponsored slot per transfer deck; it falls back to an organic pick.
  transfer: ['featured', 'rising', 'sponsored', 'fresh', 'rising', 'featured'],
  summit: ['gem', 'iconic', 'discovery', 'gem', 'iconic', 'gem'],
};

/** Fill order when there are fewer worlds than doors: the first door of every floor, band by band, then the second... */
const BAND_ORDER: Record<Band, number> = { lower: 0, transfer: 1, summit: 2, middle: 3, regular: 4 };

const AUTO_ANGLE_STEP = 62;

export function planCity(
  categories: CategoryRegistry,
  data: CityData,
  inventory: ReadonlyMap<string, number>,
  config: CityConfig,
  citadelOuter: number,
): CityPlan {
  const ringRadius = Math.max(config.ringRadius, citadelOuter + config.plazaDepth);

  // Towers from data, then any category without an entry, on free ring angles.
  const placed: { category: Category; angle: number }[] = [];
  for (const entry of data.towers) {
    const category = categories.get(entry.category);
    if (category && !placed.some((tower) => tower.category.id === category.id)) placed.push({ category, angle: entry.angle ?? NaN });
  }
  for (const category of categories.list) {
    if (!placed.some((tower) => tower.category.id === category.id)) placed.push({ category, angle: NaN });
  }
  let auto = 0;
  for (const tower of placed) {
    while (Number.isNaN(tower.angle)) {
      auto++;
      const candidate = Math.ceil(auto / 2) * AUTO_ANGLE_STEP * (auto % 2 ? 1 : -1);
      if (!placed.some((other) => Math.abs(other.angle - candidate) < AUTO_ANGLE_STEP / 2)) tower.angle = candidate;
    }
  }
  const centers = new Map(
    placed.map(({ category, angle }) => {
      const a = (angle * Math.PI) / 180;
      return [category.id, { x: Math.sin(a) * ringRadius, z: Math.cos(a) * ringRadius }];
    }),
  );

  // Bridges: explicit links, then chain any tower left unconnected to its nearest neighbour.
  const links = data.bridges.filter((link) => centers.has(link.from) && centers.has(link.to) && link.from !== link.to && link.level >= 1);
  for (const { category } of placed) {
    if (links.some((link) => link.from === category.id || link.to === category.id) || placed.length < 2) continue;
    const here = centers.get(category.id)!;
    const nearest = placed
      .filter((other) => other.category.id !== category.id)
      .sort((a, b) => distance(centers.get(a.category.id)!, here) - distance(centers.get(b.category.id)!, here))[0];
    links.push({ from: nearest.category.id, to: category.id, level: 1 + (links.length % 3) });
  }
  const bridges: BridgePlan[] = links.map((link) => {
    const a = centers.get(link.from)!;
    const b = centers.get(link.to)!;
    const heading = Math.atan2(b.x - a.x, b.z - a.z);
    const inset = config.towerRadius - 0.3;
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const floor = link.level * config.bridgeInterval;
    const start = { x: a.x + dx * inset, z: a.z + dz * inset };
    const end = { x: b.x - dx * inset, z: b.z - dz * inset };
    return {
      id: `${link.from}-${link.to}-${link.level}`,
      from: link.from,
      to: link.to,
      level: link.level,
      floor,
      y: floor * config.floorHeight,
      start,
      end,
      heading,
      length: distance(start, end),
    };
  });

  const towers = placed.map(({ category }) =>
    planTower(category, centers.get(category.id)!, inventory.get(category.id) ?? 0, bridges, config),
  );
  const outermost = Math.max(...towers.map((tower) => Math.hypot(tower.center.x, tower.center.z)));
  const byId = new Map(towers.map((tower) => [tower.id, tower]));
  return {
    towers,
    bridges,
    ringRadius,
    groundRadius: outermost + config.towerRadius + config.wallThickness + config.groundMargin,
    tower: (id) => byId.get(id),
  };
}

function planTower(
  category: Category,
  center: { x: number; z: number },
  inventory: number,
  allBridges: BridgePlan[],
  config: CityConfig,
): TowerPlan {
  const id = category.id;
  const bridges = allBridges.filter((bridge) => bridge.from === id || bridge.to === id);
  const bridgeAngle = (bridge: BridgePlan) => (bridge.from === id ? bridge.heading : bridge.heading + Math.PI);
  const frontAngle = Math.atan2(-center.x, -center.z);
  const { bands } = config;

  const topBridgeFloor = Math.max(0, ...bridges.map((bridge) => bridge.floor));
  const wanted = Math.ceil((inventory * config.exposureFactor) / config.doorsPerFloor.standard) + bands.lowerFloors + bands.summitFloors;
  const floorCount = clamp(Math.max(config.minFloors, wanted, topBridgeFloor + bands.summitFloors + 2), 1, config.maxFloors);
  const summitStart = floorCount - bands.summitFloors;

  const r = config.towerRadius;
  const bridgeHalf = (config.bridgeWidth / 2 + 0.6) / r;
  const entranceHalf = (config.entranceWidth / 2 + 0.6) / r;
  const liftHalf = 2.2 / r;
  const doorHalf = (config.doorWidth / 2 + 0.9) / r;

  // Lifts run the full height, so they avoid every bridge mouth and the entrance.
  const avoid = [frontAngle, ...bridges.map(bridgeAngle)];
  const liftAngles: number[] = [];
  for (let n = 0; n < config.fastElevatorsPerTower; n++) {
    let best = 0;
    let bestGap = -1;
    for (let step = 0; step < 144; step++) {
      const angle = frontAngle + (step / 144) * Math.PI * 2;
      const gap = Math.min(Infinity, ...[...avoid, ...liftAngles].map((other) => angularDistance(angle, other)));
      if (gap > bestGap + 1e-9) {
        bestGap = gap;
        best = angle;
      }
    }
    liftAngles.push(normalizeAngle(best));
  }

  const openings: Opening[] = [
    { angle: frontAngle, halfSpan: config.entranceWidth / 2, bottom: -1, top: config.entranceHeight },
  ];
  const floors: FloorPlan[] = [];
  for (let index = 0; index < floorCount; index++) {
    const isBridgeLevel = index > 0 && index % config.bridgeInterval === 0 && index < summitStart;
    const level = isBridgeLevel ? index / config.bridgeInterval : null;
    const kind: FloorKind = index === 0 ? 'ground' : isBridgeLevel ? 'transfer' : index >= summitStart ? 'summit' : 'standard';
    const nearBridge = (() => {
      const k = Math.round(index / config.bridgeInterval);
      return k > 0 && k * config.bridgeInterval < summitStart && Math.abs(index - k * config.bridgeInterval) <= bands.middleSpread;
    })();
    const band: Band =
      index < bands.lowerFloors ? 'lower' : kind === 'transfer' ? 'transfer' : kind === 'summit' ? 'summit' : nearBridge ? 'middle' : 'regular';
    const y = index * config.floorHeight;

    const positions: WallPosition[] = liftAngles.map((angle, liftIndex) => ({ kind: 'lift', angle, halfWidth: liftHalf, liftIndex }));
    if (kind === 'ground') positions.push({ kind: 'entrance', angle: frontAngle, halfWidth: entranceHalf });
    const floorBridges = bridges.filter((bridge) => bridge.floor === index);
    for (const bridge of floorBridges) {
      positions.push({ kind: 'bridge', angle: bridgeAngle(bridge), halfWidth: bridgeHalf, bridgeId: bridge.id });
      openings.push({ angle: bridgeAngle(bridge), halfSpan: config.bridgeWidth / 2, bottom: y - 0.2, top: y + 5.6 });
    }

    const doorCount = config.doorsPerFloor[kind];
    const angles = distributeDoors(positions, doorCount, doorHalf, frontAngle + Math.PI);
    const slots: PlacementSlot[] = [];
    angles.forEach((angle, doorIndex) => {
      const slotId = `${id}:f${index}:d${doorIndex}`;
      positions.push({ kind: 'door', angle, halfWidth: doorHalf, slotId, doorIndex });
      slots.push({
        id: slotId,
        floor: index,
        band,
        strategy: strategyFor(band, doorIndex, slotId),
        priority: doorIndex * 1e7 + BAND_ORDER[band] * 1e5 + index,
      });
    });
    positions.sort((a, b) => normalizeAngle(a.angle) - normalizeAngle(b.angle));

    floors.push({ index, kind, band, y, title: floorTitle(kind, band, level, index === floorCount - 1), bridgeLevel: level, positions, slots });
  }

  return { id, category, center, frontAngle, floorCount, floors, liftAngles, openings, bridges };
}

function strategyFor(band: Band, doorIndex: number, slotId: string): Strategy {
  if (band !== 'regular') {
    const list = BAND_STRATEGIES[band];
    return list[doorIndex % list.length];
  }
  // Regular floors mix unknown, new, established and random worlds, so
  // popularity alone never decides who gets seen.
  const roll = unitHash(slotId, 'mix');
  return roll < 0.35 ? 'discovery' : roll < 0.6 ? 'fresh' : roll < 0.85 ? 'established' : 'wildcard';
}

function floorTitle(kind: FloorKind, band: Band, level: number | null, top: boolean): string {
  if (kind === 'ground') return 'TRENDING NOW';
  if (kind === 'transfer') return `TRANSFER DECK ${level}`;
  if (top) return 'SUMMIT · ALL-TIME';
  switch (band) {
    case 'lower':
      return 'TRENDING NOW';
    case 'middle':
      return 'RISING';
    case 'summit':
      return 'HIDDEN GEMS';
    default:
      return 'DISCOVERY';
  }
}

/**
 * Spread `count` doors evenly over the wall left free by `features`, each
 * needing `doorHalf` either side. Fewer doors if they do not fit.
 */
export function distributeDoors(features: readonly { angle: number; halfWidth: number }[], count: number, doorHalf: number, startAngle = 0): number[] {
  if (count <= 0) return [];
  if (!features.length) {
    const fit = Math.min(count, Math.floor((Math.PI * 2) / (doorHalf * 2)));
    return Array.from({ length: fit }, (_, k) => normalizeAngle(startAngle + ((k + 0.5) * Math.PI * 2) / fit));
  }
  const sorted = [...features].sort((a, b) => normalizeAngle(a.angle) - normalizeAngle(b.angle));
  const arcs = sorted.map((feature, i) => {
    const next = sorted[(i + 1) % sorted.length];
    const start = normalizeAngle(feature.angle) + feature.halfWidth;
    let end = normalizeAngle(next.angle) - next.halfWidth;
    if (i === sorted.length - 1 || end < start) end += Math.PI * 2;
    return { start, length: Math.max(0, end - start) };
  });
  const capacity = arcs.map((arc) => Math.floor(arc.length / (doorHalf * 2)));
  const total = arcs.reduce((sum, arc, i) => sum + (capacity[i] > 0 ? arc.length : 0), 0);
  const fit = Math.min(count, capacity.reduce((sum, c) => sum + c, 0));
  if (!fit || total <= 0) return [];

  // Largest remainder, capped by what each arc can hold.
  const shares = arcs.map((arc, i) => (capacity[i] > 0 ? (arc.length / total) * fit : 0));
  const alloc = shares.map((share, i) => Math.min(capacity[i], Math.floor(share)));
  let left = fit - alloc.reduce((sum, n) => sum + n, 0);
  const order = shares.map((share, i) => ({ i, rest: share - Math.floor(share) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  while (left > 0) {
    let placedOne = false;
    for (const { i } of order) {
      if (left > 0 && alloc[i] < capacity[i]) {
        alloc[i]++;
        left--;
        placedOne = true;
      }
    }
    if (!placedOne) break;
  }

  const angles: number[] = [];
  arcs.forEach((arc, i) => {
    for (let j = 0; j < alloc[i]; j++) angles.push(normalizeAngle(arc.start + ((j + 0.5) * arc.length) / alloc[i]));
  });
  return angles;
}

export function normalizeAngle(angle: number): number {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

export function angularDistance(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, Math.PI * 2 - d);
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

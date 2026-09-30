import { DEFAULT_PLACEMENT_CONFIG, type PlacementConfig } from '../discovery/placement';
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from '../discovery/ranking';

/**
 * Every tunable of the tower city in one place. Components receive this
 * object; none of them hard-code a size, distance, count or timing.
 * Lengths are metres, times seconds unless the name says ms.
 */
export interface CityConfig {
  // ── City layout ──
  /** Towers stand on a ring around the citadel at least this far out. */
  ringRadius: number;
  /** ...and at least this far beyond the citadel's outer wall. */
  plazaDepth: number;
  /** The ground ends (an invisible fence) this far beyond the outermost tower wall. */
  groundMargin: number;

  // ── Tower ──
  /** Inner face of the outer wall, where the doors are. */
  towerRadius: number;
  wallThickness: number;
  /** The hole in every floor that the discovery elevator rides through. */
  shaftRadius: number;
  platformRadius: number;
  floorHeight: number;
  slabThickness: number;
  /** How tall the drawn shell is. Far past the fog, so the tower never visibly ends. */
  shellHeight: number;
  /** Floors per tower grow with the tower's listings, between these bounds. */
  minFloors: number;
  maxFloors: number;
  /** How many doors a tower wants per listing it has (above 1 means repeats across windows are rare). */
  exposureFactor: number;
  doorsPerFloor: { ground: number; standard: number; transfer: number; summit: number };
  /** Door opening width; its height follows from the 9:16 display. */
  doorWidth: number;
  doorSill: number;
  /** Width of the ground-floor entrance in the tower's outer wall. */
  entranceWidth: number;
  entranceHeight: number;
  /** Fast elevators around each tower's perimeter. */
  fastElevatorsPerTower: number;

  // ── Height bands ──
  bands: {
    /** Floors 0..lowerFloors-1 are the lower band (Trending Now). */
    lowerFloors: number;
    /** Floors this close to a bridge level are the middle band (Rising). */
    middleSpread: number;
    /** The top floors are the summit band (Hidden Gems, all-time). */
    summitFloors: number;
  };

  // ── Bridges ──
  /** Every this many floors is a bridge / transfer level. */
  bridgeInterval: number;
  bridgeWidth: number;

  // ── Streaming and level of detail ──
  floorsPerChunk: number;
  /** Chunks kept loaded above and below the player's chunk. */
  chunkRadius: number;
  /** Interiors load when the player is this close to a tower's wall. */
  detailDistance: number;

  // ── Rotation ──
  rotationIntervalMs: number;
  rotationEpochMs: number;
  shutter: { closeS: number; holdS: number; openS: number; staggerS: number };
  /** A door this close to the player waits to rotate until they walk away. */
  holdRadius: number;

  // ── Previews ──
  maxActiveVideos: number;
  maxActiveVideosMobile: number;
  /** Doors closer than this (and in view) may play video. */
  videoActivationDistance: number;
  /** Doors closer than this (and in view) animate their poster. Beyond, a still poster. */
  animationDistance: number;
  /** A preview out of view this long gives its video element back. */
  videoReleaseS: number;
  /** World cards kept in memory (posters and captions). */
  maxCachedCards: number;

  // ── Discovery elevator ──
  elevatorSpeed: number;
  elevatorCallSpeed: number;
  /** Pause at each floor while riding, long enough to step off. */
  elevatorDwellS: number;
  elevatorBoardDelayS: number;

  // ── Interaction ──
  /** A prompt to enter shows within this distance of a door. */
  doorReach: number;
  /** Walking this close into a door enters it. */
  enterDepth: number;

  placement: PlacementConfig;
  ranking: RankingWeights;
}

export const DEFAULT_CITY_CONFIG: CityConfig = {
  ringRadius: 105,
  plazaDepth: 70,
  groundMargin: 60,

  towerRadius: 16,
  wallThickness: 1.4,
  shaftRadius: 5.4,
  platformRadius: 5.28,
  floorHeight: 7.5,
  slabThickness: 0.6,
  shellHeight: 1600,
  minFloors: 26,
  maxFloors: 400,
  exposureFactor: 1.5,
  doorsPerFloor: { ground: 5, standard: 8, transfer: 5, summit: 6 },
  doorWidth: 2.2,
  doorSill: 0.25,
  entranceWidth: 7,
  entranceHeight: 6.2,
  fastElevatorsPerTower: 2,

  bands: { lowerFloors: 4, middleSpread: 1, summitFloors: 3 },

  bridgeInterval: 10,
  bridgeWidth: 6,

  floorsPerChunk: 4,
  chunkRadius: 1,
  detailDistance: 40,

  rotationIntervalMs: 6 * 60 * 60 * 1000,
  rotationEpochMs: Date.UTC(2026, 0, 1),
  shutter: { closeS: 0.85, holdS: 0.45, openS: 0.95, staggerS: 2.4 },
  holdRadius: 4.5,

  maxActiveVideos: 3,
  maxActiveVideosMobile: 1,
  videoActivationDistance: 18,
  animationDistance: 30,
  videoReleaseS: 4,
  maxCachedCards: 64,

  elevatorSpeed: 1.7,
  elevatorCallSpeed: 6,
  elevatorDwellS: 2.6,
  elevatorBoardDelayS: 1.2,

  doorReach: 3.4,
  enterDepth: 0.5,

  placement: DEFAULT_PLACEMENT_CONFIG,
  ranking: DEFAULT_RANKING_WEIGHTS,
};

/**
 * Defaults, with development-only overrides from the address bar:
 * `?rotation=60` (seconds per window), `?videos=2`, `?floors=40`.
 */
export function resolveCityConfig(overrides: Partial<CityConfig> = {}): CityConfig {
  const config: CityConfig = { ...DEFAULT_CITY_CONFIG, ...overrides };
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(window.location.search);
    const rotation = Number(params.get('rotation'));
    if (rotation > 0) config.rotationIntervalMs = rotation * 1000;
    const videos = Number(params.get('videos'));
    if (params.has('videos') && videos >= 0) config.maxActiveVideos = config.maxActiveVideosMobile = videos;
    const floors = Number(params.get('floors'));
    if (floors > 0) config.minFloors = floors;
  }
  return config;
}

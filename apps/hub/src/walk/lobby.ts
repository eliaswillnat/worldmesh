import {
  AVATAR_TICKET_PARAM,
  buildTravelUrl,
  createWorldMesh,
  isStrokeMaterial,
  Presence,
  setAvatarAppear,
  setAvatarColor,
  setStrokeOpacity,
  type Vec3Tuple,
} from '@worldmesh/runtime';
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  DirectionalLight,
  DoubleSide,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Fog,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_GLOW_WHITE, applyCityTheme, applySkyTheme, createCityMaterials, createSky, createSpawnRay, flipInside, skyHorizon, type BillboardSlot } from './city';
import { DOOR_HALF_SPAN, DOOR_HEIGHT, DOOR_TOP, DOOR_WIDTH, FRAME, Door, createLabel, worldIsFull, type DoorWorld } from './door';
import { doorFrameGeometry, frameOuterCorner, roundedOpeningGeometry } from './doorShape';
import { ImageCropper } from '../cropper';
import { describeBillboard } from './layout';
import { Assembly } from './assemble';
import { FLOOR_NAMES, Lifts, buildShafts, createColliderMaterial, mergeInto, planLifts } from './elevators';
import {
  DRUM_HEIGHT,
  GALLERY_LEVELS,
  MEDIA_BOTTOM,
  MEDIA_MAX_HEIGHT,
  OCULUS_RADIUS,
  buildDome,
  buildGalleries,
  createConcourseSign,
  createDepartureBoard,
  domeShape,
  rod,
  type Flight,
} from './rotunda';
import { fetchBillboards } from '../ads/api';
import { AdBillboards, type BillboardHit } from '../ads/billboards';
import { AD_CONFIG, normalizeDestinationUrl } from '../ads/config';
import { openAdModal } from '../ads/modal';
import type { SignalSource } from '../discovery/ranking';
import { canonicalUrl, type WorldRecordInput } from '../worlds/listing';

/** A place in the lobby and the way to face there. */
export interface WalkSpot {
  position: Vec3Tuple;
  yaw: number;
}

/** A listed world: what its door needs, plus what the tower city files it under. */
export type LobbyWorld = DoorWorld & WorldRecordInput;

export interface LobbyOptions {
  worlds: LobbyWorld[];
  /** Walk out of the door behind this spot instead of starting in the middle of the hall. */
  start?: WalkSpot | null;
  /** Draw the lobby white with dark lines instead of black with light ones. */
  light?: boolean;
  /** WebSocket base URL of the presence server. Leave empty for single-player. */
  presenceEndpoint?: string;
  /** Name shown above this visitor for everyone else; null shows them as a guest. */
  playerName?: () => string | null;
  /** Start in private mode (see `Lobby.setPrivate`). */
  private?: boolean;
  /** Default-character tint. Forgotten on refresh; only a return from a world restores it. */
  color?: string | null;
  /** Called with how many people are in the lobby, or null while offline. */
  onPresenceCount?: (count: number | null) => void;
  /**
   * Called right before the page navigates into a world, with where to put
   * the visitor if they come back: just outside that door, facing the room.
   */
  onEnterWorld?: (world: DoorWorld, returnTo: WalkSpot) => void;
  /** Called when someone picks an empty door to add their own world. */
  onAddWorld?: () => void;
  /**
   * Someone claimed an empty door from inside the lobby. The door already
   * shows their world here; this asks the gallery to list it as well.
   */
  onClaimWorld?: (world: ClaimedWorld) => void;
  /**
   * Mount the billboard ads UI (outlines, +, prompts, modal, live ads).
   * Off by default; pass true only when ads are deliberately enabled
   * (`AD_CONFIG.enabled` / `VITE_ADS_ENABLED`).
   */
  ads?: boolean;
  /** Visit counts and the like, for ranking worlds in the towers. */
  signals?: SignalSource;
  /** How many times people have entered a world, by URL; shown beside its doors. */
  entries?: (url: string) => number | undefined;
  /**
   * `performance.now()` when the visitor hit Walk. The spawn beam starts from
   * that moment so load time does not delay it.
   */
  enteredAt?: number;
}

export interface Lobby {
  /** Add doors (and tower listings) for worlds that were not listed yet. */
  setWorlds(worlds: LobbyWorld[]): void;
  /** Entry counts changed: update the numbers beside every door. */
  refreshEntries(): void;
  /**
   * Switch between the dark and light lobby. Purely local: other visitors
   * keep whatever their own device prefers.
   */
  setTheme(light: boolean): void;
  /**
   * Private mode: this visitor becomes a see-through ghost (to themselves;
   * everyone else just sees the plain default figure), goes by a made-up
   * name instead of their username, and carries no avatar into worlds.
   * Switching either way sends them back to the spawn point as a new
   * arrival, so nobody can follow them from one identity to the other.
   * Returns the made-up name while private, or null.
   */
  setPrivate(on: boolean): string | null;
  /** Tint the default character. Has no effect once a custom avatar is on. */
  setColor(color: string): void;
  /** The made-up name while private, or null while public. */
  readonly alias: string | null;
  dispose(): void;
}

/** How often walk-mode doors ask presence how full each world room is. */
const OCCUPANCY_MS = 15_000;

/** Presence WebSocket base → HTTP base for the public occupancy read. */
function presenceHttpBase(endpoint: string): string {
  return endpoint.replace(/\/$/, '').replace(/^ws/i, 'http');
}

/** Origin of a world URL, lower-cased, or null if it is not http(s). */
function worldRoomOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}
const FLOOR_LAYER = 1;
const FLOOR_SIZE = 600;
/** The citadel: never narrower than this, and grows so doors keep this much wall between them. */
const WALL_MIN_RADIUS = 11;
/** How far the walkable plaza reaches around the lobby. */
const PLAZA_RADIUS = 120;
const DOOR_SPACING = 4.2;
/** A tall drum under a glass dome, with the doors around the inside of its base. */
const CITADEL_HEIGHT = DRUM_HEIGHT;
const WALL_THICKNESS = 1.2;

/**
 * The wall above a doorway. Its lower edge is the frame's outer top:
 * straight across, with the same rounded corners, then up to the drum.
 * `span` is half the frame's outer width, in metres.
 */
function roundedWallHead(
  radius: number,
  angle: number,
  span: number,
  holeTop: number,
  wallTop: number,
  cornerX: number,
  cornerY: number,
): BufferGeometry {
  const rx = Math.min(cornerX, span);
  const ry = Math.min(cornerY, holeTop);
  const left = -span + rx;
  const right = span - rx;
  const arcBase = holeTop - ry;
  const arc = 16;
  const edge: { s: number; y: number }[] = [];
  for (let i = 0; i <= arc; i++) {
    const t = Math.PI - (i / arc) * (Math.PI / 2);
    edge.push({ s: left + Math.cos(t) * rx, y: arcBase + Math.sin(t) * ry });
  }
  const middle = Math.max(1, Math.ceil((right - left) / 0.5));
  for (let i = 1; i < middle; i++) edge.push({ s: left + ((right - left) * i) / middle, y: holeTop });
  for (let i = 0; i <= arc; i++) {
    const t = Math.PI / 2 - (i / arc) * (Math.PI / 2);
    edge.push({ s: right + Math.cos(t) * rx, y: arcBase + Math.sin(t) * ry });
  }

  const columns = edge.length;
  const positions: number[] = [];
  const point = (s: number, y: number) => {
    const theta = angle + s / radius;
    positions.push(Math.sin(theta) * radius, y, Math.cos(theta) * radius);
  };
  for (const sample of edge) point(sample.s, sample.y);
  for (const sample of edge) point(sample.s, wallTop);
  const indices: number[] = [];
  for (let i = 0; i < columns - 1; i++) {
    const a = i;
    const b = i + 1;
    const c = columns + i;
    const d = columns + i + 1;
    indices.push(a, b, d, a, d, c);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return flipInside(geometry);
}
/** Ways out to the city, evenly around the drum. Sealed for now. Angle 0 faces +Z, behind you on arrival. */
const GATE_COUNT = 4;
const GATE_WIDTH = 4.4;
const GATE_HEIGHT = 6.2;
/** Wall kept clear on each side of a gate before the first door. */
const GATE_MARGIN = DOOR_SPACING;

/** Gate angles around the hall, starting at +Z. */
function gateAngles(): number[] {
  return Array.from({ length: GATE_COUNT }, (_, i) => (i / GATE_COUNT) * Math.PI * 2);
}

/**
 * Door angles around the drum. Each stretch of wall between two gates is a
 * bay, and every bay gets the same number of doors. Within a bay the doors
 * are spaced so the clear gap beside each gate equals the clear gap between
 * neighbouring doors — both sides of an exit match.
 */
function doorAngles(total: number, radius: number): number[] {
  const gates = gateAngles();
  const bay = (Math.PI * 2) / GATE_COUNT;
  const count = Math.floor(total / GATE_COUNT);
  if (count <= 0) return [];
  const bayMetres = bay * radius;
  // Centre-to-centre pitch. The +1 counts the gap on each side of the bay as
  // one more interval, so those gaps come out equal to the ones between doors.
  const pitch = (bayMetres - GATE_WIDTH + 2 * DOOR_HALF_SPAN) / (count + 1);
  const first = GATE_WIDTH / 2 + pitch - DOOR_HALF_SPAN;
  const angles: number[] = [];
  for (const gate of gates) {
    for (let i = 0; i < count; i++) angles.push(gate + (first + i * pitch) / radius);
  }
  return angles.map((angle) => (angle + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
}
/**
 * Slot indexes for `count` worlds on a ring of `total` doors: side by side,
 * so the worlds people added sit together. Worlds keep a stable order around the wall.
 */
function distribute(count: number, total: number): number[] {
  return Array.from({ length: Math.min(count, total) }, (_, i) => i);
}

/** Doors round each gallery: smaller, to fit under the floor above, and this far apart. */
const GALLERY_DOOR_SCALE = 0.62;
const GALLERY_DOOR_PITCH = 5.2;

/** The hall always has at least this many doors, and always a few empty ones. */
const MIN_DOORS = 32;
const SPARE_DOORS = 6;
/** Stand this close in front of an empty door to be offered it. */
const EMPTY_DOOR_REACH = 4.8;
/** A tap on an empty door this far away still counts. */
const WARP_MS = 450;
/** Someone back from a world ends up this far out in front of the door they took. */
const RETURN_STEP = 2.4;
/**
 * Coming back, they appear this far behind the doorway's face, hidden by it,
 * and walk out through it for WALK_OUT_S seconds.
 */
const WALK_OUT_FROM = -0.6;
const WALK_OUT_S = 1.5;
/** The flash holds this long before fading, so there is a frame to fade from. */
const FLASH_HOLD_S = 0.1;
/**
 * In third person the camera starts in the hall looking at the door, then
 * swings round behind them as they finish walking out.
 */
const TURN_FROM_S = 1.1;
const TURN_S = 0.8;
/**
 * The door just walked out of stays shut until they are this far from it.
 * Otherwise the camera, swung round behind them, backs out through the
 * open doorway and ends up looking at the back of the door.
 */
const EXIT_CLEAR = 4;
/** Where every visitor arrives: the middle of the hall. Each arrival looks a different way. */
const SPAWN: Vec3Tuple = [0, 0, 0];
/** How long the screen stays white while switching in or out of private mode. */
const PRIVATE_FADE_MS = 260;
/** The ghost's opacity, and how far its shimmer swings either side of it. */
const GHOST_OPACITY = 0.38;
const GHOST_SHIMMER = 0.08;
const GHOST_GLOW = 0x5cc8ff;
/**
 * Someone else first seen this close to the spawn point has just entered, so
 * the beam lights for us too. Inside the nearest door's return spot (8.6 m), so
 * visitors walking back out of a world do not set it off.
 */
const ARRIVE_RADIUS = 6;
/** Billboards further than this are not picked by the crosshair or a tap. */
const BILLBOARD_RANGE = 95;
/** How often the billboard under the crosshair is looked up, in seconds. */
const FOCUS_INTERVAL = 0.1;
/** Billboard bookings are refreshed this often while walking. */
const BILLBOARD_REFRESH_MS = 60_000;
/** The random door stands on the citadel's outer wall, this far along it from the gate. */
const RANDOM_DOOR_ARC = 8.2;
/** How far the random door stands out from the outer wall. */
const RANDOM_DOOR_OUT = 0.3;

/** The ring of light that runs across the floor on each arrival: metres per second, and seconds it lasts. */
const WAVE_SPEED = 14;
const WAVE_TIME = 2.4;

/** How rough the floor is: 0 is a perfect mirror, 1 a softly blurred, uneven stone. */
const FLOOR_ROUGHNESS = 1;

/**
 * The floor is one mirror plane whose shader also draws the grid. Drawing the
 * grid as a second plane just above the mirror depth-fights on GPUs with low
 * depth precision, and costs an extra full-screen pass.
 */
const floorShader = {
  name: 'WorldMeshFloor',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uPlayer: { value: new Vector2() },
    uLight: { value: 0 },
    uBackground: { value: new Color() },
    uHaze: { value: new Color() },
    uRough: { value: FLOOR_ROUGHNESS },
    uHall: { value: 0 },
    uWave: { value: -1 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;

    #include <common>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uPlayer;
    uniform float uLight;
    uniform vec3 uBackground;
    uniform vec3 uHaze;
    uniform float uRough;
    uniform float uHall;
    uniform float uWave;
    varying vec4 vUv;
    varying vec3 vWorld;

    #include <logdepthbuf_pars_fragment>

    float gridLine(vec2 coord) {
      vec2 g = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), vec2(1e-4));
      return 1.0 - min(min(g.x, g.y), 1.0);
    }

    float line1(float coord, float width) {
      return 1.0 - min(abs(fract(coord - 0.5) - 0.5) / max(width, 1e-4), 1.0);
    }

    // Spokes round the hall's centre. atan jumps at -x, so take the width
    // from whichever of two half-turned angles is smooth there.
    float spokes(vec2 p, float count) {
      float a = atan(p.y, p.x) / 6.2831853 * count;
      float b = atan(-p.y, -p.x) / 6.2831853 * count;
      return line1(a, min(fwidth(a), fwidth(b)));
    }

    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }

    void main() {
      #include <logdepthbuf_fragment>

      // A slightly rough floor rather than a perfect mirror: the surface is a
      // little uneven, so reflections waver and soften, and its sheen varies
      // from spot to spot. All of it is pinned to the floor, so nothing crawls.
      vec2 ground = vWorld.xz;
      vec2 wobble = vec2(valueNoise(ground * 1.3), valueNoise(ground * 1.3 + 17.0)) - 0.5;
      vec4 uv = vUv;
      // texture2DProj divides by w, so offsets scaled by w are in texture space.
      uv.xy += wobble * (0.004 * uRough) * uv.w;
      vec2 spread = vec2(0.004 * uRough) * uv.w;
      vec3 reflection = texture2DProj(tDiffuse, uv).rgb * 0.4
        + texture2DProj(tDiffuse, uv + vec4(spread.x, spread.y * 0.5, 0.0, 0.0)).rgb * 0.15
        + texture2DProj(tDiffuse, uv + vec4(-spread.x * 0.5, spread.y, 0.0, 0.0)).rgb * 0.15
        + texture2DProj(tDiffuse, uv + vec4(-spread.x, -spread.y * 0.5, 0.0, 0.0)).rgb * 0.15
        + texture2DProj(tDiffuse, uv + vec4(spread.x * 0.5, -spread.y, 0.0, 0.0)).rgb * 0.15;
      // Patchy sheen, plus a fine grain that fades out before it gets smaller than a pixel.
      float patches = valueNoise(ground * 0.45) * 0.6 + valueNoise(ground * 2.1) * 0.4;
      vec2 grainCoord = ground * 26.0;
      float grainVisible = 1.0 - smoothstep(0.35, 0.9, max(fwidth(grainCoord).x, fwidth(grainCoord).y));
      float grain = (valueNoise(grainCoord) - 0.5) * grainVisible;
      float rough = ((patches - 0.5) * 0.9 + grain * 1.2) * uRough;

      float minor = gridLine(vWorld.xz / 2.0);
      float major = gridLine(vWorld.xz / 10.0);
      // Fade out well before the horizon, where dense lines would add up to a bright band.
      float dist = distance(vWorld.xz, cameraPosition.xz);
      float fade = 1.0 - smoothstep(12.0, 75.0, dist);
      float minorFade = 1.0 - smoothstep(8.0, 40.0, dist);
      // Lines light up a little around the player.
      float glow = 1.0 - smoothstep(0.0, 14.0, distance(vWorld.xz, uPlayer));
      // Inside the rotunda the square grid gives way to an inlay round the
      // centre: rings every 3 m, spokes, and a border band inside the wall.
      float rr = length(vWorld.xz);
      float inside = 1.0 - smoothstep(uHall - 0.6, uHall, rr);
      float ringMinor = line1(rr / 3.0, fwidth(rr / 3.0));
      float ringWidth = max(fwidth(rr), 1e-4);
      float ringMajor = 1.0 - min(min(abs(rr - 6.0), min(abs(rr - uHall + 1.2), abs(rr - uHall + 0.9))) / ringWidth, 1.0);
      float spokeMinor = spokes(vWorld.xz, 32.0) * smoothstep(4.0, 8.0, rr);
      float spokeMajor = spokes(vWorld.xz, 8.0) * smoothstep(2.4, 3.0, rr);
      float radial = max(max(ringMinor, spokeMinor) * 0.08 * minorFade, max(ringMajor, spokeMajor) * 0.2);
      float square = max(minor * 0.08 * minorFade, major * 0.2);
      // On each arrival a ring of light runs out from the platform along the
      // lines, fading as it goes. uWave is seconds since the spawn, or < 0.
      float wave = 0.0;
      if (uWave >= 0.0) {
        float front = uWave * ${WAVE_SPEED.toFixed(1)};
        float ring = exp(-pow((rr - front) / 2.2, 2.0));
        float trail = smoothstep(front + 1.0, front - 6.0, rr) * step(rr, front + 1.0) * 0.35;
        wave = max(ring, trail) * (1.0 - smoothstep(0.0, ${WAVE_TIME.toFixed(1)}, uWave)) * (1.0 - smoothstep(0.0, uHall, rr) * 0.6);
      }
      float lines = mix(square, radial, inside) * fade * (1.0 + glow * 1.6 + wave * 6.0);

      // A mirror under a tinted glaze: glossier at grazing angles, faint
      // looking straight down. The rough patches take some of the shine off.
      vec3 toCamera = normalize(cameraPosition - vWorld);
      float glaze = clamp(mix(0.78, 0.96, abs(toCamera.y)) + rough * 0.12, 0.0, 1.0);

      // Dark: black stone with light lines. Light: white stone with ink lines.
      // A faint speckle keeps the black from reading as a flat void.
      vec3 darkFloor = reflection * (1.0 - glaze) * (1.0 - lines) + vec3(lines) + vec3(max(rough, 0.0) * 0.006);
      darkFloor *= 0.5;
      vec3 lightFloor = mix(reflection, uBackground * (1.0 - rough * 0.035), glaze) * (1.0 - min(lines * 1.4, 1.0));
      lightFloor *= 0.8;

      // Melt into the fog at the horizon, like everything else.
      float haze = smoothstep(60.0, 230.0, dist);
      gl_FragColor = vec4(mix(mix(darkFloor, lightFloor, uLight), uHaze, haze), 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/**
 * Walk mode: the directory as a place. You arrive inside the citadel, a tall
 * round hall whose wall is lined with a door per listed world; walking into
 * one travels to that world. Gates to the plaza are closed for now. Movement,
 * camera, touch controls and portal triggers all come from the same runtime
 * the worlds themselves use.
 */
export function createLobby(container: HTMLElement, options: LobbyOptions): Lobby {
  const renderer = new WebGLRenderer({ antialias: true });
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const background = new Color();
  const fog = new Fog(0x000000, 25, 100);
  scene.background = background;
  scene.fog = fog;
  let light = options.light ?? false;

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 420);
  camera.layers.enable(FLOOR_LAYER);

  const hemisphere = new HemisphereLight(0xffffff, 0x202020, 1.6);
  scene.add(hemisphere);
  const sky = createSky();
  scene.add(sky);
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(4, 10, 6);
  scene.add(sun);
  const spawnRay = createSpawnRay(CITADEL_HEIGHT + 170, FLOOR_LAYER);
  scene.add(spawnRay.object);
  // The local figure assembling out of points on arrival.
  const assembly = new Assembly(FLOOR_LAYER);
  /** Lobby clock when the last spawn's ring of light set off across the floor; negative = none. */
  let waveStarted = -1;
  /** Other visitors' figures assembling as they arrive, each with its own points. */
  const arrivals: Array<{ assembly: Assembly; root: Object3D }> = [];
  let newestFigure: Object3D | null = null;
  scene.add(assembly.points);

  const wallMaterial = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.7, metalness: 0 });
  const innerWallMaterial = new MeshBasicMaterial({ side: DoubleSide });
  const gateFrameMaterial = new MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 });
  // The dome's glazing and the gallery rails.
  const glassMaterial = new MeshStandardMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    roughness: 0.08,
    metalness: 0.4,
  });
  // Over the middle of the hall: every world and the gate to find it at.
  // Glass lifts up to the galleries, and the walkable galleries they reach.
  const liftTrim = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const lifts = new Lifts({ glass: glassMaterial, trim: liftTrim, body: wallMaterial, floor: gateFrameMaterial });
  scene.add(lifts.group);
  const liftPoint = new Vector3();
  const colliderMaterial = createColliderMaterial();
  /** Gallery decks, rails and landings. Rebuilt with the hall. */
  const upper: Mesh[] = [];
  const departures = createDepartureBoard();
  scene.add(departures.group);
  let flights: Flight[] = [];
  // Door angles round the hall, in gate-number order.
  let hallAngles: number[] = [];
  const cityMaterials = createCityMaterials(renderer.capabilities.getMaxAnisotropy());
  let disposed = false;
  const mirror = new Reflector(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
    shader: floorShader,
    ...mirrorResolution(),
  });
  mirror.rotation.x = -Math.PI / 2;
  scene.add(mirror);
  const floorUniforms = (mirror.material as ShaderMaterial).uniforms;
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

  // Billboard ads: only mount when deliberately enabled (off by default) and the plaza has screens for them.
  // Nothing outside the lobby carries a screen right now.
  const billboardSlots: BillboardSlot[] = [];
  const adsEnabled = options.ads === true && billboardSlots.length > 0;
  const billboards = adsEnabled
    ? new AdBillboards({
        light,
        touch: isTouch,
        maxTextureSize: renderer.capabilities.maxTextureSize,
        anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
      })
    : null;
  if (billboards) scene.add(billboards.group);
  applyTheme();

  // The name presence sends right now. It only changes together with a
  // rejoin, so the old connection never carries the new name.
  let alias: string | null = options.private ? randomAlias() : null;
  // Where a switch in progress is heading; equal to alias otherwise.
  let pendingAlias = alias;
  let ghost: Ghost | null = null;
  let privateTimer = 0;
  const presence = options.presenceEndpoint
    ? new Presence({
        url: `${options.presenceEndpoint.replace(/\/$/, '')}/room/lobby`,
        scene,
        onCount: (count) => options.onPresenceCount?.(count),
        getName: () => (alias ? null : options.playerName?.() ?? null),
        getAlias: () => alias,
        // Someone else entering lights the same beam for everyone watching.
        // Visitors coming back out of a world appear at a door, not here.
        // Each new figure is handed over just before its arrival is reported.
        onFigure: (root) => {
          newestFigure = root;
        },
        // Someone arriving gets the same show as we do: the beam, their figure
        // assembling out of three point clones, and the ring across the floor.
        onArrive: (x, z) => {
          if (Math.hypot(x - SPAWN[0], z - SPAWN[2]) >= ARRIVE_RADIUS) return;
          spawnRay.trigger();
          waveStarted = time;
          if (newestFigure) startArrival(newestFigure);
          newestFigure = null;
        },
      })
    : undefined;

  // The citadel's walls (solid) and trim (just for looks). Rebuilt whenever
  // the door count changes.
  const wall: Mesh[] = [];
  const trim: Mesh[] = [];
  const gateSeals: Group[] = [];
  const gateLabelDraw: Array<(isLight: boolean) => void> = [];
  let interiorBannerRing: Group | null = null;
  let interiorBannerAngle = 0;
  // Standing on something is required once there are walls to bump into.
  const ground = new Mesh(
    new CircleGeometry(1, 48),
    new MeshStandardMaterial({ opacity: 0, transparent: true, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const known = new Map<string, DoorWorld>();
  const doors = new Map<string, Door>();
  // Doors with no world behind them yet. Re-laid out with every list change.
  const emptyDoors: Door[] = [];
  // Empty doors round the galleries. Rebuilt with the hall.
  const galleryDoors: Door[] = [];
  // Outside, set into the tower beside the gate: a glowing blue door to a
  // random listed world.
  const randomDoor = new Door(null, light, true);
  scene.add(randomDoor.group);
  let nearEmpty: Door | null = null;
  let time = 0;
  let warping = false;
  let beamWobble = 0;
  // The lobby door being walked through, if it was one (not a tower door).
  let warpDoor: Door | null = null;
  let warpTimer = 0;
  // Outside the door the visitor last went through, for when they come back.
  let returnTo: WalkSpot | null = null;
  let emerging: Emerging | null = null;
  let exitDoor: Door | null = null;

  const flash = document.createElement('div');
  flash.className = 'walk-flash';
  // Arriving back from a world: start in the same light the warp left in.
  if (options.start) flash.classList.add('active');
  container.appendChild(flash);

  const addPrompt = document.createElement('button');
  addPrompt.type = 'button';
  addPrompt.className = 'walk-add-prompt';
  addPrompt.textContent = isTouch ? 'Tap to put your world in this door' : 'Press E or click to put your world in this door';
  addPrompt.addEventListener('click', (event) => {
    event.stopPropagation();
    addWorld();
  });
  container.appendChild(addPrompt);

  // Inside a lift: up and down buttons (E and Q on a keyboard).
  const liftPrompt = document.createElement('div');
  liftPrompt.className = 'walk-add-prompt walk-lift-prompt';
  if (!isTouch) {
    const liftHint = document.createElement('span');
    liftHint.textContent = 'E up · Q down';
    liftPrompt.append(liftHint);
  }
  for (const [label, step, name] of [['▲', 1, 'Up'], ['▼', -1, 'Down']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'walk-lift-step';
    button.dataset.step = String(step);
    button.textContent = label;
    button.setAttribute('aria-label', name);
    // On press rather than click: the touch controls can swallow the click that would follow.
    button.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      event.preventDefault();
      lifts.move(liftPoint.fromArray(world.getState().position), step);
    });
    liftPrompt.append(button);
  }
  for (const type of ['pointerdown', 'pointerup']) liftPrompt.addEventListener(type, (event) => event.stopPropagation());
  container.appendChild(liftPrompt);

  // Offered while a billboard is under the crosshair (or centred on a phone).
  const adPrompt = document.createElement('button');
  adPrompt.type = 'button';
  adPrompt.className = 'walk-add-prompt walk-ad-prompt';
  adPrompt.addEventListener('click', (event) => {
    event.stopPropagation();
    if (focused) activateBillboard(focused);
  });
  if (adsEnabled) container.appendChild(adPrompt);
  let focused: BillboardHit | null = null;
  let sinceFocus = 0;
  let adModal: { close(): void } | null = null;
  let claimModal: { close(): void } | null = null;
  let billboardFetch: AbortController | null = null;
  let occupancyTimer = 0;
  let occupancyFetch: AbortController | null = null;
  /** Last count/cap by world origin, so newly laid doors can show full immediately. */
  const occupancyByOrigin = new Map<string, { count: number; cap: number }>();

  const world = createWorldMesh({
    scene,
    camera,
    renderer,
    spawn: SPAWN,
    // Held upright, look further down so the floor fills the tall screen instead of the sky.
    view: { mode: 'third', distance: 5.5, pitch: window.innerWidth < window.innerHeight ? -0.32 : -0.15 },
    vr: true,
    ui: { title: 'WorldMesh', badge: false, crosshair: false, deferLockPanel: true, moveBeforeLock: true },
    network: presence,
    // Empty doors are closed: their faces stop you like the wall does.
    colliders: () => [
      ground,
      ...wall,
      ...emptyDoors.map((door) => door.face),
      ...galleryDoors.map((door) => door.face),
      ...(exitDoor ? [exitDoor.face] : []),
      ...spawnRay.colliders,
      ...upper,
      ...lifts.colliders,
    ],
    onUpdate: (dt, handle) => {
      time += dt;
      if (emerging) stepEmerging(dt);
      departures.update(dt);
      if (interiorBannerRing) {
        interiorBannerAngle += dt * ((Math.PI * 2) / 360);
        interiorBannerRing.rotation.y = interiorBannerAngle;
      }
      // In a lift: carried with the cab, and kept inside its glass.
      if (!emerging && !warping) {
        const held = lifts.update(dt, liftPoint.fromArray(handle.getState().position));
        if (held) world.setState({ position: held.toArray() });
        updateLiftPrompt();
      }
      const [x, y, z] = handle.getState().position;
      // Only doors on the floor they are standing on.
      const level = (door: Door) => Math.abs(y - door.group.position.y) < 1;
      if (exitDoor && !emerging) {
        const { x: doorX, z: doorZ } = exitDoor.inFront(0);
        if (Math.hypot(x - doorX, z - doorZ) > EXIT_CLEAR) setExitDoor(null);
      }
      for (const door of [...doors.values(), randomDoor]) {
        door.update(time);
        if (level(door) && !warping && !emerging && door.contains(x, z)) enter(door);
      }
      let near: Door | null = null;
      let nearest = EMPTY_DOOR_REACH;
      for (const door of [...emptyDoors, ...galleryDoors]) {
        door.update(time);
        const distance = level(door) ? door.distanceInFront(x, z) : null;
        if (distance !== null && distance < nearest) {
          nearest = distance;
          near = door;
        }
      }
      if (near !== nearEmpty) {
        nearEmpty?.setHover(false);
        near?.setHover(true);
        nearEmpty = near;
        addPrompt.classList.toggle('visible', near !== null);
      }
      updateBillboardFocus(dt, near !== null);
      billboards?.update(dt, camera);
      floorUniforms.uPlayer.value.set(x, z);
      floorUniforms.uWave.value = waveStarted < 0 || time - waveStarted > WAVE_TIME ? -1 : time - waveStarted;
      // The sky is centred on the camera, so it stays around it however high the towers take them.
      sky.position.copy(camera.position);
      const beamPresence = spawnRay.setTime(time);
      // Arriving: the figure assembles out of points, and shows through as they land.
      updateArrivals(dt);
      const appear = assembly.update(dt, camera, renderer.domElement.height);
      if (appear !== null) {
        if (ghost) ghost.shimmer(time, appear);
        else setLocalAppear(world.avatar, appear);
      } else if (ghost) {
        ghost.shimmer(time);
      }
      // A small shake that grows as the camera nears the shaft. Strength eases
      // in and out so walking into the beam does not snap. The rig rewrites the
      // camera next frame, so this does not accumulate.
      const rayDistance = Math.hypot(x, z);
      const rayT = Math.min(1, Math.max(0, (rayDistance - 0.6) / 7));
      const rayNear = 1 - rayT * rayT * (3 - 2 * rayT);
      const wobbleTarget = rayNear * rayNear * 0.0065 * beamPresence * beamPresence;
      const wobbleEase = 1 - Math.exp(-dt * 4.5);
      beamWobble += (wobbleTarget - beamWobble) * wobbleEase;
      const wobble = beamWobble;
      camera.position.x += Math.sin(time * 46) * wobble + Math.sin(time * 71) * wobble * 0.35;
      camera.position.y += Math.sin(time * 58 + 1.1) * wobble * 0.55;
      camera.position.z += Math.sin(time * 39 + 0.6) * wobble * 0.4;
      // Keep the finite floor under the player. The grid is drawn in world
      // space, so moving the plane does not move the lines.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      placeChatBubble();
    },
  });
  if (alias) ghost = makeGhost(world.avatar);

  // Chat is a bubble over your head. Enter opens it, Enter sends it, then it
  // follows you around until it fades. There is no transcript.
  const chatBubble = document.createElement('form');
  chatBubble.className = 'walk-bubble';
  const chatField = document.createElement('input');
  chatField.type = 'text';
  chatField.maxLength = 80;
  chatField.autocomplete = 'off';
  chatField.placeholder = 'say something';
  chatField.setAttribute('aria-label', 'Say something');
  chatField.enterKeyHint = 'send';
  const chatClose = document.createElement('button');
  chatClose.type = 'button';
  chatClose.className = 'walk-bubble-close';
  chatClose.textContent = '×';
  chatClose.setAttribute('aria-label', 'Close chat');
  const chatSaid = document.createElement('p');
  chatBubble.append(chatField, chatClose, chatSaid);
  container.appendChild(chatBubble);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup']) {
    chatBubble.addEventListener(type, (event) => event.stopPropagation());
  }
  let chatting = false;
  let chatUntil = 0;
  const chatPoint = new Vector3();

  chatField.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Do not preventDefault: that cancels the browser leaving pointer lock.
    closeChat();
  });

  chatClose.addEventListener('click', () => closeChat());

  chatBubble.addEventListener('submit', (event) => {
    event.preventDefault();
    const line = chatField.value.trim();
    chatting = false;
    chatField.blur();
    chatField.value = '';
    endChat();
    if (!line) {
      chatUntil = 0;
      chatBubble.classList.remove('visible', 'saying');
      return;
    }
    chatSaid.textContent = line;
    chatUntil = performance.now() + 7000;
    chatBubble.classList.remove('saying');
    presence?.say(line);
  });

  function openChat(): void {
    if (chatting) return;
    if (claimModal || adModal || warping) return;
    if (document.querySelector('.wm-overlay')?.getAttribute('data-locked') !== 'true') return;
    chatting = true;
    chatSaid.textContent = '';
    chatBubble.classList.add('saying');
    document.documentElement.classList.add('chatting');
    chatField.focus();
  }

  const handleChatKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.repeat || chatting) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    openChat();
  };
  window.addEventListener('keydown', handleChatKey);

  // Q inside a lift takes it down a floor (E, the interact key, takes it up).
  const handleLiftKey = (event: KeyboardEvent) => {
    if (event.code !== 'KeyQ' || event.repeat || chatting) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    lifts.move(liftPoint.fromArray(world.getState().position), -1);
  };
  window.addEventListener('keydown', handleLiftKey);

  // On touch devices, a chat button replaces the Enter key for opening chat,
  // and tapping outside the bubble dismisses it (replaces Escape).
  let chatBtn: HTMLButtonElement | null = null;
  if (isTouch) {
    chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'walk-chat-btn';
    chatBtn.textContent = '💬';
    chatBtn.title = 'Chat';
    chatBtn.setAttribute('aria-label', 'Open chat');
    chatBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openChat();
    });
    container.appendChild(chatBtn);

    container.addEventListener('pointerdown', (e) => {
      if (!chatting) return;
      if ((e.target as HTMLElement)?.closest('.walk-bubble, .walk-chat-btn')) return;
      closeChat();
    });
  }

  /** Mouse look stays put while the bubble is open, without unlocking the cursor. */
  const holdLook = (event: Event) => {
    if (chatting) event.stopPropagation();
  };
  document.addEventListener('mousemove', holdLook, true);
  document.addEventListener('wheel', holdLook, true);

  function closeChat(): void {
    chatting = false;
    chatField.value = '';
    chatField.blur();
    chatBubble.classList.remove('saying');
    endChat();
  }

  function endChat(): void {
    document.documentElement.classList.remove('chatting');
  }

  /** Pin the local bubble to the head. Everyone else's is glued to their figure. */
  function placeChatBubble(): void {
    const show = chatting || performance.now() < chatUntil;
    if (!show) {
      chatBubble.classList.remove('visible');
      return;
    }
    const [x, y, z] = world.getState().position;
    chatPoint.set(x, y + 2.45, z).project(camera);
    if (chatPoint.z > 1) {
      chatBubble.classList.remove('visible');
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    chatBubble.style.left = `${(chatPoint.x * 0.5 + 0.5) * rect.width}px`;
    chatBubble.style.top = `${(-chatPoint.y * 0.5 + 0.5) * rect.height}px`;
    chatBubble.classList.add('visible');
  }
  // Fire as soon as the world is running — before doors/towers finish building —
  // and backdate to the Walk click so the beam does not wait on load.
  if (!options.start) triggerSpawnFx(options.enteredAt);

  /** Walking through a lobby door: flash, then travel to the world's own URL. */
  function enter(door: Door): void {
    const target = door.random ? pickRandomWorld() : door.world;
    if (!target) return;
    door.surge();
    const out = door.inFront(RETURN_STEP * door.group.scale.x);
    travel(target, { position: [out.x, door.group.position.y, out.z], yaw: out.yaw }, door);
  }

  /**
   * Into a world, from a lobby door or a tower door: flash, then go to its
   * own URL. `spot` is where to come back out.
   */
  function travel(target: DoorWorld, spot: WalkSpot, door: Door | null): void {
    if (warping) return;
    warping = true;
    warpDoor = door;
    returnTo = spot;
    options.onEnterWorld?.(target, returnTo);
    document.exitPointerLock?.();
    flash.classList.add('active');
    const url = travelUrl(target.url);
    warpTimer = window.setTimeout(() => {
      window.location.href = url;
    }, WARP_MS);
  }

  /** A world's URL with `from` added, and the avatar ticket unless private. */
  function travelUrl(target: string): string {
    const url = buildTravelUrl(target);
    if (!alias) return url;
    try {
      const parsed = new URL(url);
      const params = new URLSearchParams(parsed.hash.slice(1));
      if (!params.has(AVATAR_TICKET_PARAM)) return url;
      params.delete(AVATAR_TICKET_PARAM);
      parsed.hash = params.toString();
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function pickRandomWorld(): DoorWorld | null {
    const worlds = [...known.values()];
    return worlds.length ? worlds[Math.floor(Math.random() * worlds.length)] : null;
  }

  /** True when this URL already opens a door in the hall or in any tower. */
  function doorTaken(url: string): boolean {
    const key = canonicalUrl(url);
    for (const knownUrl of known.keys()) if (canonicalUrl(knownUrl) === key) return true;
    for (const claim of loadClaims()) if (canonicalUrl(claim.url) === key) return true;
    return false;
  }

  /** An empty door was picked, in the hall or in a tower: claim it from inside the lobby. */
  function addWorld(): void {
    if (warping || claimModal || !nearEmpty) return;
    document.exitPointerLock?.();
    const door = nearEmpty;
    claimModal = openClaimModal(light, {
      taken: doorTaken,
      onClose: () => {
        claimModal = null;
      },
      onClaim: (world) => {
        if (doorTaken(world.url)) return;
        placeClaim(door, world);
        options.onClaimWorld?.(world);
      },
    });
  }

  /** The first person at this empty door keeps it: their world opens here. */
  function placeClaim(empty: Door, world: ClaimedWorld): void {
    const angle = typeof empty.group.userData.angle === 'number' ? empty.group.userData.angle : Math.atan2(empty.group.position.x, empty.group.position.z);
    const { x, y, z } = empty.group.position;
    const level = typeof empty.group.userData.level === 'number' ? empty.group.userData.level : 0;
    const scale = empty.group.scale.x;
    for (const list of [emptyDoors, galleryDoors]) {
      const index = list.indexOf(empty);
      if (index >= 0) list.splice(index, 1);
    }
    if (nearEmpty === empty) {
      nearEmpty = null;
      addPrompt.classList.remove('visible');
    }
    empty.dispose();
    saveClaim({ angle, level, name: world.name, url: world.url, cover: world.cover });
    const door = new Door({ name: world.name, url: world.url, cover: world.cover }, light);
    door.setEntries(options.entries?.(world.url));
    const origin = worldRoomOrigin(world.url);
    const info = origin ? occupancyByOrigin.get(origin) : undefined;
    door.setFull(info ? worldIsFull(info.count, info.cap) : false);
    scene.add(door.group);
    door.place(x, z, 0, 0);
    door.group.position.y = y;
    door.group.scale.setScalar(scale);
    door.group.userData.angle = angle;
    door.group.userData.level = level;
    known.set(world.url, { name: world.name, url: world.url, cover: world.cover });
    doors.set(world.url, door);
    const slot = level ? -1 : hallAngles.findIndex((candidate) => angleDelta(candidate, angle) < 0.08);
    if (slot >= 0) {
      door.setGate(slot + 1);
      flights = [...flights, { name: world.name, gate: slot + 1, cover: world.cover }].sort((a, b) => a.gate - b.gate);
      departures.setFlights(flights);
    }
    void refreshOccupancy();
  }

  // Keyboard: E at a tower door, lift or elevator, or next to an empty door.
  // The runtime reports E as a plain interaction when no portal of its own is in reach.
  world.on('respawn', () => {
    aimSpawn();
  });
  world.on('interact', () => {
    if (lifts.move(liftPoint.fromArray(world.getState().position), 1)) return;
    if (nearEmpty) addWorld();
  });

  /** Inside a standing lift: which floor to go to. */
  function updateLiftPrompt(): void {
    const inside = lifts.aboard(liftPoint.fromArray(world.getState().position));
    const show = !!inside && !inside.moving;
    liftPrompt.classList.toggle('visible', show);
    if (!inside) return;
    liftPrompt.dataset.lift = String(inside.index);
    // No going up from the top or down from the bottom.
    for (const button of liftPrompt.querySelectorAll<HTMLButtonElement>('button[data-step]')) {
      const next = inside.floor + Number(button.dataset.step);
      button.disabled = next < 0 || next >= FLOOR_NAMES.length;
    }
  }

  // Pointer: clicking or tapping a tower door or a billboard. While the mouse
  // is captured there is no cursor, so a click aims where the camera looks.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pressAt: { x: number; y: number; time: number } | null = null;
  const handlePointerDown = (event: PointerEvent) => {
    pressAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    if (document.pointerLockElement !== renderer.domElement || adModal || claimModal || event.button !== 0) return;
    // A click aims where the camera looks: a tower door there, or a billboard.
    const hit = billboardAt(0, 0);
    if (hit) activateBillboard(hit);
  };
  const handlePointerUp = (event: PointerEvent) => {
    const press = pressAt;
    pressAt = null;
    if (!press || document.pointerLockElement === renderer.domElement || adModal || claimModal) return;
    // A mouse click while the cursor is free captures it for looking. It is not a tap on a door.
    if (event.pointerType === 'mouse') return;
    // A tap, not a drag to look around or a push on the joystick.
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 10 || performance.now() - press.time > 400) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = billboardAt(ndcX, ndcY);
    if (hit) activateBillboard(hit);
  };

  /** The billboard at a point on screen, unless a wall or tower is in front of it. */
  function billboardAt(ndcX: number, ndcY: number): BillboardHit | null {
    if (!adsEnabled || !billboards) return null;
    raycaster.setFromCamera(pointer.set(ndcX, ndcY), camera);
    raycaster.far = BILLBOARD_RANGE;
    return billboards.pick(raycaster, [...wall, ...trim]);
  }

  /** Follow the crosshair (the middle of the screen on phones) a few times a second. */
  function updateBillboardFocus(dt: number, doorPrompt: boolean): void {
    if (!adsEnabled || !billboards) return;
    sinceFocus += dt;
    if (sinceFocus < FOCUS_INTERVAL) return;
    sinceFocus = 0;
    const active = !adModal && !claimModal && !warping && !doorPrompt && (document.pointerLockElement === renderer.domElement || isTouch);
    const hit = active ? billboardAt(0, 0) : null;
    const same = hit?.slot === focused?.slot && hit?.kind === focused?.kind;
    focused = hit;
    billboards.setFocus(hit?.slot ?? null);
    if (same) return;
    adPrompt.classList.toggle('visible', !!hit);
    if (!hit) return;
    const verb = isTouch ? 'Tap' : 'Click';
    if (hit.kind === 'empty') {
      adPrompt.textContent = `${verb} to advertise here · ${AD_CONFIG.priceLabel}`;
    } else if (hit.kind === 'reserved') {
      adPrompt.textContent = 'Reserved · an ad is in review';
    } else {
      const host = hit.ad ? safeHost(hit.ad.url) : null;
      adPrompt.textContent = host ? `Ad · ${verb} to visit ${host} ↗` : 'Ad';
    }
  }

  /** Clicked or tapped: book an empty billboard, or visit an ad's website. */
  function activateBillboard(hit: BillboardHit): void {
    if (!adsEnabled || !billboards || adModal || warping) return;
    if (hit.kind === 'ad' && hit.ad) {
      // Checked again here, whatever the server said: only plain https links open.
      const url = normalizeDestinationUrl(hit.ad.url);
      if (!url) return;
      document.exitPointerLock?.();
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (hit.kind !== 'empty') return;
    const { plan } = hit.slot;
    // Free the mouse and stop the controls before the form takes over.
    document.exitPointerLock?.();
    focused = null;
    billboards.setFocus(null);
    adPrompt.classList.remove('visible');
    adModal = openAdModal({
      slot: { id: plan.id, width: plan.width, height: plan.height, wide: plan.wide, description: describeBillboard(plan.id) },
      light,
      onClose: () => {
        adModal = null;
      },
      onSubmitted: () => void refreshBillboards(),
    });
  }

  /** Which billboards carry ads, and which are held for one in review. */
  async function refreshBillboards(): Promise<void> {
    if (!adsEnabled || !billboards || disposed) return;
    billboardFetch?.abort();
    const controller = new AbortController();
    billboardFetch = controller;
    try {
      billboards.setStates(await fetchBillboards(controller.signal));
    } catch {
      // Offline or the ads service is down: screens stay as they were.
    }
  }
  const billboardTimer = adsEnabled
    ? window.setInterval(() => {
        if (document.visibilityState === 'visible') void refreshBillboards();
      }, BILLBOARD_REFRESH_MS)
    : 0;
  if (adsEnabled) void refreshBillboards();
  // Always listening: taps and clicks also enter tower doors.
  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointerup', handlePointerUp);

  // Coming back with the browser's back button can restore this page as it
  // was left: mid-warp and standing in a doorway. Step the visitor back out.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    window.clearTimeout(warpTimer);
    warpDoor?.settle();
    warpDoor = null;
    warping = false;
    flash.classList.remove('active');
    if (returnTo) emerge(returnTo);
    else {
      world.respawn();
      triggerSpawnFx();
    }
  };
  window.addEventListener('pageshow', handlePageShow);

  const handleResize = () => {
    const { textureWidth, textureHeight } = mirrorResolution();
    mirror.getRenderTarget().setSize(textureWidth, textureHeight);
    // A phone held upright sees a narrow slice of the world; widen the lens so
    // the doors around you stay in view.
    const aspect = window.innerWidth / window.innerHeight;
    camera.fov = aspect < 1 ? 70 + (1 - aspect) * 30 : 70;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', handleResize);
  handleResize();

  setWorlds(options.worlds);
  // Stored coordinates rather than a door to look up: community worlds arrive
  // a moment later and shift every door, and these already match the full list.
  if (options.start) emerge(options.start);
  startOccupancyPolling();

  if (import.meta.env.DEV) Object.assign(window, { lobby: world, spawnFx: () => triggerSpawnFx() });

  return {
    setWorlds,
    refreshEntries,
    setTheme,
    setPrivate,
    setColor,
    get alias() {
      return pendingAlias;
    },
    dispose,
  };

  /** Another visitor arrived: hide their figure and assemble it out of points, as ours is. */
  function startArrival(root: Object3D): void {
    const assembly = new Assembly(FLOOR_LAYER);
    assembly.setTheme(light);
    scene.add(assembly.points);
    assembly.start(() => (root.parent ? root : null));
    root.visible = false;
    arrivals.push({ assembly, root });
  }

  function updateArrivals(dt: number): void {
    for (let i = arrivals.length - 1; i >= 0; i--) {
      const { assembly, root } = arrivals[i];
      // They left before it finished.
      const gone = !root.parent;
      const appear = gone ? null : assembly.update(dt, camera, renderer.domElement.height);
      if (appear === null) {
        if (!gone) {
          root.visible = true;
          setLocalAppear(root, 1);
        }
        assembly.dispose();
        arrivals.splice(i, 1);
        continue;
      }
      // Hidden until the clones merge, then faded in where they meet.
      root.visible = appear > 0;
      if (appear > 0) setLocalAppear(root, appear);
    }
  }

  /** Beam + local figure fade-in when arriving at the spawn point. */
  function triggerSpawnFx(fromWallClock?: number): void {
    spawnRay.trigger(fromWallClock);
    assembly.start(() => world.avatar);
    waveStarted = time;
    if (ghost) ghost.shimmer(time, 0);
    else setLocalAppear(world.avatar, 0);
    aimSpawn();
  }

  /** Pick a new look direction and turn the body toward the camera. */
  function aimSpawn(): void {
    const yaw = Math.random() * Math.PI * 2;
    world.setState({ yaw, facing: yaw + Math.PI });
  }

  /** Come back out of the door behind `spot`, walking a few steps into the hall. */
  function emerge(spot: WalkSpot): void {
    const [x, , z] = spot.position;
    // Light up the door they come out of, if it is there yet: community
    // worlds may still be loading.
    const door = [...doors.values(), randomDoor].find((candidate) => {
      const out = candidate.inFront(RETURN_STEP);
      return Math.hypot(out.x - x, out.z - z) < 0.5;
    }) ?? null;
    door?.surge();
    // Open until they are out: it would stop them walking through it.
    if (exitDoor) setExitDoor(null);
    emerging = { spot, door, time: 0, orbit: world.getViewMode() === 'third' };
    stepEmerging(0);
  }

  function stepEmerging(dt: number): void {
    const { spot, door, orbit } = emerging!;
    const t = (emerging!.time += dt);
    if (t >= FLASH_HOLD_S) flash.classList.remove('active');

    // Ease out: a walk that slows to a stop at the spot.
    const walk = Math.min(t / WALK_OUT_S, 1);
    // Out in front of it now: shut it behind them before the camera comes round.
    if (walk === 1 && door && exitDoor !== door) setExitDoor(door);
    const length = RETURN_STEP - WALK_OUT_FROM;
    const along = WALK_OUT_FROM + length * Math.sin((walk * Math.PI) / 2) - RETURN_STEP;
    const speed = walk < 1 ? ((length * Math.PI) / 2 / WALK_OUT_S) * Math.cos((walk * Math.PI) / 2) : 0;
    // Looking along spot.yaw faces out of the door, into the hall.
    const forwardX = -Math.sin(spot.yaw);
    const forwardZ = -Math.cos(spot.yaw);
    const turn = orbit ? Math.min(Math.max((t - TURN_FROM_S) / TURN_S, 0), 1) : 1;
    const eased = turn * turn * (3 - 2 * turn);
    world.setState({
      position: [spot.position[0] + forwardX * along, spot.position[1], spot.position[2] + forwardZ * along],
      // The velocity is only there so the body walks instead of gliding.
      velocity: [forwardX * speed, 0, forwardZ * speed],
      yaw: spot.yaw - Math.PI * (1 - eased),
      facing: spot.yaw,
    });
    door?.surge(1 - walk);

    if (walk === 1 && turn === 1) {
      door?.settle();
      emerging = null;
    }
  }

  /** Shut `door` behind someone who just walked out of it, or null to open it again. */
  function setExitDoor(door: Door | null): void {
    exitDoor = door;
    world.refreshColliders();
  }

  function setColor(color: string): void {
    setAvatarColor(world.avatar, color);
  }

  if (options.color) setColor(options.color);

  function setPrivate(on: boolean): string | null {
    if (on === !!pendingAlias || warping || emerging) return pendingAlias;
    const next = on ? randomAlias() : null;
    pendingAlias = next;
    // A quick white-out hides the jump back to the start.
    window.clearTimeout(privateTimer);
    flash.classList.add('active');
    privateTimer = window.setTimeout(() => {
      alias = next;
      world.clearAvatar();
      ghost?.restore();
      ghost = alias ? makeGhost(world.avatar) : null;
        world.teleport(SPAWN, 0);
      triggerSpawnFx();
      presence?.rejoin();
      flash.classList.remove('active');
    }, PRIVATE_FADE_MS);
    return next;
  }

  function setTheme(isLight: boolean): void {
    if (isLight === light) return;
    light = isLight;
    applyTheme();
    for (const door of [...doors.values(), ...emptyDoors, ...galleryDoors, randomDoor]) door.setTheme(light);
    for (const draw of gateLabelDraw) draw(light);
  }

  function applyTheme(): void {
    // Light: a plain blue sky over pale towers. Dark: a faint grey horizon deepening to black
    // overhead, the towers lit by their windows and doors. The fog matches the horizon, reaches
    // past the towers so they read across the plaza, and swallows their tops.
    background.set(skyHorizon(light));
    renderer.setClearColor(background);
    applySkyTheme(sky, light);
    fog.color.copy(background);
    fog.near = light ? 70 : 45;
    fog.far = light ? 300 : 230;
    hemisphere.groundColor.set(light ? 0xdde5f2 : 0x202020);
    hemisphere.intensity = light ? 2 : 1.6;
    spawnRay.setTheme(light);
    assembly.setTheme(light);
    for (const arrival of arrivals) arrival.assembly.setTheme(light);
    floorUniforms.uBackground.value.set(light ? 0xf1f4fa : 0x000000);
    floorUniforms.uHaze.value.copy(background);
    floorUniforms.uLight.value = light ? 1 : 0;
    wallMaterial.color.set(light ? 0xf5f6fa : 0x141418);
    // Unlit: the sky lights would otherwise wash a highlight around the drum.
    innerWallMaterial.color.set(light ? 0xc8ceda : 0x07070a);
    gateFrameMaterial.color.set(light ? 0x1c1c1c : 0xf2f2f2);
    // Clear by day with the sky behind it; a faint smoked sheen at night.
    glassMaterial.color.set(light ? 0xe4eef9 : 0x9aa8bf);
    glassMaterial.opacity = light ? 0.22 : 0.1;
    departures.setTheme(light);
    // Lift the shaded sides so white stays white, not grey.
    wallMaterial.emissive.set(light ? CITY_GLOW_WHITE : 0x000000);
    applyCityTheme(cityMaterials, light);
    billboards?.setTheme(light);
  }

  function refreshEntries(): void {
    for (const [url, door] of doors) door.setEntries(options.entries?.(url));
  }

  function applyOccupancy(): void {
    for (const [url, door] of doors) {
      const origin = worldRoomOrigin(url);
      const info = origin ? occupancyByOrigin.get(origin) : undefined;
      door.setFull(info ? worldIsFull(info.count, info.cap) : false);
    }
  }

  async function refreshOccupancy(): Promise<void> {
    if (!options.presenceEndpoint || disposed) return;
    const origins = [...new Set([...doors.keys()].map(worldRoomOrigin).filter((o): o is string => !!o))];
    if (!origins.length) {
      occupancyByOrigin.clear();
      applyOccupancy();
      return;
    }
    occupancyFetch?.abort();
    const controller = new AbortController();
    occupancyFetch = controller;
    try {
      const base = presenceHttpBase(options.presenceEndpoint);
      const res = await fetch(`${base}/occupancy?origins=${encodeURIComponent(origins.join(','))}`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, { count?: unknown; cap?: unknown }>;
      occupancyByOrigin.clear();
      for (const [origin, value] of Object.entries(data)) {
        const count = Number(value?.count);
        const cap = Number(value?.cap);
        if (!Number.isFinite(count) || !Number.isFinite(cap)) continue;
        occupancyByOrigin.set(origin.toLowerCase(), { count, cap });
      }
      if (!disposed) applyOccupancy();
    } catch {
      // Network or abort — leave the last known full/not-full state.
    } finally {
      if (occupancyFetch === controller) occupancyFetch = null;
    }
  }

  function startOccupancyPolling(): void {
    if (!options.presenceEndpoint) return;
    void refreshOccupancy();
    if (occupancyTimer) window.clearInterval(occupancyTimer);
    occupancyTimer = window.setInterval(() => {
      void refreshOccupancy();
    }, OCCUPANCY_MS);
  }

  function setWorlds(worlds: LobbyWorld[]): void {
    for (const entry of worlds) {
      if (!known.has(entry.url)) known.set(entry.url, entry);
    }

    // Everyone with the same list gets the same ring, so visitors who see
    // each other also see the same doors around them.
    // A door claimed inside the lobby stays on the opening it was given.
    // Once that world is published, it joins the ordinary ring instead.
    // Gallery claims are put back by hangGalleryDoors.
    const claims = loadClaims().filter((claim) => !claim.level && !worlds.some((entry) => entry.url === claim.url));
    const claimUrls = new Set(claims.map((claim) => claim.url));
    const urls = [...known.keys()].filter((url) => !claimUrls.has(url)).sort();
    // A multiple of the gate count, so every bay — and both sides of every exit — match.
    const needed = Math.max(MIN_DOORS, urls.length + SPARE_DOORS);
    const total = needed + ((GATE_COUNT - (needed % GATE_COUNT)) % GATE_COUNT);
    const gateArc = GATE_COUNT * (GATE_WIDTH + GATE_MARGIN * 2);
    const radius = Math.max(WALL_MIN_RADIUS, (total * DOOR_SPACING + gateArc) / (Math.PI * 2));
    // Doors share the wall between the gates.
    const angles = doorAngles(total, radius);
    // Worlds sit next to each other; the doors after them stay empty.
    const slots = distribute(urls.length, total);
    const at = (door: Door, slot: number) => {
      // Set into the wall, facing the middle of the room, under its gate number.
      door.place(Math.sin(angles[slot]) * radius, Math.cos(angles[slot]) * radius, 0, 0);
      door.setGate(slot + 1);
    };

    urls.forEach((url, i) => {
      let door = doors.get(url);
      if (!door) {
        door = new Door(known.get(url)!, light);
        door.setEntries(options.entries?.(url));
        scene.add(door.group);
        doors.set(url, door);
      }
      at(door, slots[i]);
    });

    for (const door of emptyDoors) door.dispose();
    emptyDoors.length = 0;
    nearEmpty = null;
    addPrompt.classList.remove('visible');
    const taken = new Set(slots);
    for (const slot of angles.map((_, i) => i).filter((i) => !taken.has(i))) {
      const angle = angles[slot];
      const claim = claims.find((entry) => angleDelta(entry.angle, angle) < 0.08);
      if (claim) {
        let door = doors.get(claim.url);
        if (!door) {
          door = new Door({ name: claim.name, url: claim.url, cover: claim.cover }, light);
          door.setEntries(options.entries?.(claim.url));
          scene.add(door.group);
          known.set(claim.url, { name: claim.name, url: claim.url, cover: claim.cover });
          doors.set(claim.url, door);
        }
        at(door, slot);
        door.group.userData.angle = angle;
        continue;
      }
      const door = new Door(null, light);
      scene.add(door.group);
      at(door, slot);
      door.group.userData.angle = angle;
      emptyDoors.push(door);
    }
    // Gates are numbered round the hall from the first door after exit A.
    hallAngles = angles;
    flights = [];
    urls.forEach((url, i) => flights.push({ ...pick(known.get(url)!), gate: slots[i] + 1 }));
    for (const claim of claims) {
      const slot = angles.findIndex((angle) => angleDelta(claim.angle, angle) < 0.08);
      if (slot >= 0 && !taken.has(slot)) flights.push({ name: claim.name, cover: claim.cover, gate: slot + 1 });
    }
    flights.sort((a, b) => a.gate - b.gate);
    departures.setFlights(flights);
    buildWall(radius, angles);
    applyOccupancy();
    void refreshOccupancy();
  }

  /**
   * The citadel: an inner and an outer drum with the doorways cut into the
   * inner one and the gate cut through both, then trim, the banner over the
   * gate, and the city around it.
   */
  function buildWall(radius: number, angles: number[]): void {
    for (const mesh of [...wall, ...trim]) {
      if (mesh.userData.ownMaterial) {
        const material = mesh.material as MeshBasicMaterial;
        material.map?.dispose();
        material.dispose();
      }
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    wall.length = 0;
    trim.length = 0;
    gateLabelDraw.length = 0;
    for (const group of gateSeals) group.removeFromParent();
    gateSeals.length = 0;
    const outer = radius + WALL_THICKNESS;

    const shell = (r: number, start: number, length: number, bottom: number, inward: boolean) => {
      if (length <= 0) return;
      const height = CITADEL_HEIGHT - bottom;
      const segments = Math.max(2, Math.ceil(length * 24));
      const geometry = new CylinderGeometry(r, r, height, segments, 1, true, start, length);
      const section = new Mesh(inward ? flipInside(geometry) : geometry, inward ? innerWallMaterial : wallMaterial);
      section.position.y = bottom + height / 2;
      scene.add(section);
      wall.push(section);
    };

    // Inner drum: faces the hall, open at each doorway. The cut follows the
    // frame's rounded top, not a rectangle. Sealed exits use the same opening.
    const outerCorner = frameOuterCorner(DOOR_WIDTH, DOOR_HEIGHT, FRAME);
    const openings = [
      ...gateAngles().map((angle) => ({ angle, half: DOOR_HALF_SPAN / radius, top: DOOR_TOP })),
      ...angles.map((angle) => ({ angle, half: DOOR_HALF_SPAN / radius, top: DOOR_TOP })),
    ].sort((a, b) => a.angle - b.angle);
    openings.forEach((opening, i) => {
      const next = openings[i + 1] ?? { ...openings[0], angle: openings[0].angle + Math.PI * 2 };
      const start = opening.angle + opening.half;
      shell(radius, start, next.angle - next.half - start, 0, true);
      const head = new Mesh(
        roundedWallHead(radius, opening.angle, DOOR_HALF_SPAN, opening.top, CITADEL_HEIGHT, outerCorner.rx, outerCorner.ry),
        innerWallMaterial,
      );
      scene.add(head);
      wall.push(head);
    });

    // Outer drum: faces the city, sealed at each gate for now.
    const gateOuter = GATE_WIDTH / 2 / outer;
    const gateStep = (Math.PI * 2) / GATE_COUNT;
    for (const angle of gateAngles()) {
      shell(outer, angle + gateOuter, gateStep - gateOuter * 2, 0, false);
      shell(outer, angle - gateOuter, gateOuter * 2, 0, false);
    }

    // Each sealed exit is a normal door, closed. Same rounded top as the others.
    for (const angle of gateAngles()) {
      const plug = new Mesh(roundedOpeningGeometry(DOOR_WIDTH, DOOR_HEIGHT, 0.08), innerWallMaterial);
      const frame = new Mesh(doorFrameGeometry(DOOR_WIDTH, DOOR_HEIGHT, FRAME, 0.32), gateFrameMaterial);
      const sealed = new Group();
      sealed.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      sealed.rotation.y = Math.atan2(-Math.sin(angle), -Math.cos(angle));
      plug.position.z = 0.04;
      sealed.add(plug, frame);
      scene.add(sealed);
      gateSeals.push(sealed);
      wall.push(plug);
      for (const mesh of sealed.children) {
        if (mesh !== plug && mesh instanceof Mesh && !mesh.userData.ownMaterial) wall.push(mesh);
      }
      const sign = createLabel('Extension\nUnder\nConstruction', undefined, true);
      sign.draw(light);
      sign.mesh.userData.ownMaterial = true;
      sign.mesh.position.set(0, DOOR_HEIGHT / 2, 0.14);
      sealed.add(sign.mesh);
      trim.push(sign.mesh);
      gateLabelDraw.push(sign.draw);
      // Wayfinding over the exit, as in a terminal.
      const concourse = createConcourseSign(String.fromCharCode(65 + gateSeals.length - 1));
      concourse.draw(light);
      concourse.mesh.userData.ownMaterial = true;
      concourse.mesh.position.set(0, DOOR_TOP + 1.4, 0.25);
      sealed.add(concourse.mesh);
      trim.push(concourse.mesh);
      gateLabelDraw.push(concourse.draw);
    }

    floorUniforms.uHall.value = radius;

    buildTrim(radius, outer);
    buildCity(outer);
    world.refreshColliders();
  }

  /**
   * A ring of doors round the wall of each gallery.
   * They start empty; a world claimed in one stays on that gallery.
   */
  function hangGalleryDoors(radius: number): void {
    for (const door of galleryDoors) door.dispose();
    galleryDoors.length = 0;
    nearEmpty = null;
    addPrompt.classList.remove('visible');
    // A claimed world that has since been published has a door in the hall instead.
    const claims = loadClaims().filter((claim) => {
      const existing = doors.get(claim.url);
      return claim.level && !(existing && !existing.group.userData.level);
    });
    const r = radius - 0.12;
    GALLERY_LEVELS.forEach((height, index) => {
      const level = index + 1;
      const count = Math.floor((Math.PI * 2 * r) / GALLERY_DOOR_PITCH);
      for (let i = 0; i < count; i++) {
        const angle = ((i + 0.5) / count) * Math.PI * 2;
        const claim = claims.find((entry) => entry.level === level && angleDelta(entry.angle, angle) < 0.02);
        let door = claim ? doors.get(claim.url) : undefined;
        if (claim && !door) {
          door = new Door({ name: claim.name, url: claim.url, cover: claim.cover }, light);
          door.setEntries(options.entries?.(claim.url));
          scene.add(door.group);
          known.set(claim.url, { name: claim.name, url: claim.url, cover: claim.cover });
          doors.set(claim.url, door);
        }
        if (!door) {
          door = new Door(null, light);
          scene.add(door.group);
          galleryDoors.push(door);
        }
        door.place(Math.sin(angle) * r, Math.cos(angle) * r, 0, 0);
        door.group.position.y = height;
        door.group.scale.setScalar(GALLERY_DOOR_SCALE);
        door.group.userData.angle = angle;
        door.group.userData.level = level;
      }
    });
  }

  /** Ribs, light bands, the crown, the gate's portal frame and the banner. */
  function buildTrim(radius: number, outer: number): void {
    const solid: BufferGeometry[] = [];
    const glow: BufferGeometry[] = [];
    const matrix = new Matrix4();
    const place = (geometry: BufferGeometry, x: number, y: number, z: number, angle = 0) => {
      geometry.applyMatrix4(matrix.makeRotationY(angle).setPosition(x, y, z));
      return geometry.index ? geometry.toNonIndexed() : geometry;
    };

    // Vertical ribs all round the outside, leaving each gate and the banner bare.
    const bare = 5 / outer;
    const ribCount = Math.round((Math.PI * 2 * outer) / 3.2);
    for (let i = 0; i < ribCount; i++) {
      const angle = (i / ribCount) * Math.PI * 2;
      const byGate = gateAngles().some((gate) => {
        let delta = Math.abs(angle - gate);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        return delta < bare;
      });
      if (byGate) continue;
      const r = outer + 0.2;
      solid.push(place(new BoxGeometry(0.5, CITADEL_HEIGHT, 0.4), Math.sin(angle) * r, CITADEL_HEIGHT / 2, Math.cos(angle) * r, angle));
    }

    // Crown: a cornice around the top, the drum's rim, and the glass dome
    // over the hall with the oculus the spawn beam rises through.
    solid.push(place(new CylinderGeometry(outer + 0.5, outer + 0.5, 1.2, 128, 1, true), 0, CITADEL_HEIGHT - 0.6, 0));
    const rim = new RingGeometry(radius, outer + 0.5, 128, 1);
    rim.rotateX(-Math.PI / 2);
    solid.push(place(rim, 0, CITADEL_HEIGHT, 0));
    const dome = buildDome(radius);
    solid.push(...dome.solid);
    glow.push(...dome.glow);

    // Galleries ringing the drum, one over the other.
    const liftPlan = planLifts(radius);
    const galleries = buildGalleries(radius, liftPlan.gaps);
    solid.push(...galleries.solid);
    glow.push(...galleries.glow);
    const shafts = buildShafts(liftPlan, radius);
    solid.push(...shafts.solid);
    glow.push(...shafts.glow);
    galleries.glass.push(...shafts.glass);
    for (const mesh of upper) mesh.geometry.dispose();
    upper.length = 0;
    upper.push(mergeInto([...galleries.colliders.map((g) => (g.index ? g.toNonIndexed() : g)), ...shafts.colliders], colliderMaterial));
    lifts.setLifts(liftPlan);
    const glazing = new Mesh(mergeGeometries([dome.glass, ...galleries.glass].map((g) => (g.index ? g.toNonIndexed() : g))), glassMaterial);
    for (const geometry of [dome.glass, ...galleries.glass]) geometry.dispose();
    // Drawn after the opaque hall, so the rails and the dome stay see-through.
    glazing.renderOrder = 3;
    scene.add(glazing);
    trim.push(glazing);
    hangGalleryDoors(radius);

    // The departures board hangs from the oculus ring on four cables.
    const { oculusY } = domeShape(radius);
    for (const corner of departures.hangers) {
      const anchor = corner.clone().setY(oculusY - 0.2);
      anchor.multiplyScalar(OCULUS_RADIUS / Math.hypot(anchor.x, anchor.z)).setY(oculusY - 0.2);
      glow.push(rod(corner, anchor, 0.02));
    }

    // Light bands: outside above the gate and under the crown, inside above
    // the doors (one unbroken line under the banners) and near the top.
    const band = (r: number, y: number, start = 0, length = Math.PI * 2) =>
      glow.push(place(new CylinderGeometry(r, r, 0.07, 128, 1, true, start, length), 0, y, 0));
    band(outer + 0.03, GATE_HEIGHT + 1.2);
    band(outer + 0.52, CITADEL_HEIGHT - 1.3);
    band(radius - 0.03, DOOR_TOP + 2.8);
    band(radius - 0.03, CITADEL_HEIGHT - 1);

    // The concourse mouth on the outside: the same rounded doorway, at gate size.
    const frameR = outer + 0.2;
    const atGate = (localZ: number, angle: number): [number, number] => [
      Math.sin(angle) * localZ,
      Math.cos(angle) * localZ,
    ];
    for (const angle of gateAngles()) {
      const [x, z] = atGate(frameR, angle);
      const [glowX, glowZ] = atGate(frameR + 0.2, angle);
      solid.push(place(doorFrameGeometry(GATE_WIDTH, GATE_HEIGHT, 0.6, 0.5), x, 0, z, angle));
      glow.push(place(doorFrameGeometry(GATE_WIDTH, GATE_HEIGHT, 0.05, 0.05), glowX, 0, glowZ, angle));
    }

    // A tall screen over every gate, facing the plaza. Explore and Discover
    // alternate, each at its own picture's shape, in a deep white bezel.
    const portrait = [cityMaterials.banners.explore, cityMaterials.banners.discover];
    const bannerH = 14;
    const bannerBottom = GATE_HEIGHT + 2.4;
    const banners: Mesh[] = [];
    gateAngles().forEach((angle, index) => {
      const art = portrait[index % portrait.length];
      const bannerW = bannerH * art.aspect;
      const y = bannerBottom + bannerH / 2;
      const bezelZ = outer - 0.35;
      const faceZ = outer + 0.37;
      solid.push(place(new BoxGeometry(bannerW + 0.6, bannerH + 0.6, 1.4), Math.sin(angle) * bezelZ, y, Math.cos(angle) * bezelZ, angle));
      glow.push(place(new BoxGeometry(bannerW + 0.6, 0.05, 0.05), Math.sin(angle) * faceZ, bannerBottom - 0.35, Math.cos(angle) * faceZ, angle));
      const banner = new Mesh(new PlaneGeometry(bannerW, bannerH), art.material);
      banner.position.set(Math.sin(angle) * faceZ, y, Math.cos(angle) * faceZ);
      banner.rotation.y = angle;
      banners.push(banner);
    });

    hangInteriorBanners(radius);

    // The random door's backing and porch, on the outer wall beside the gate.
    const doorAngle = RANDOM_DOOR_ARC / outer;
    const around = (r: number) => [Math.sin(doorAngle) * r, Math.cos(doorAngle) * r] as const;
    const [backX, backZ] = around(outer - 0.05);
    solid.push(place(new BoxGeometry(5.6, DOOR_TOP + 2.2, 0.5), backX, (DOOR_TOP + 2.2) / 2, backZ, doorAngle));
    const [porchX, porchZ] = around(outer + 0.55);
    solid.push(place(new BoxGeometry(5.6, 0.16, 0.9), porchX, DOOR_TOP + 0.75, porchZ, doorAngle));
    const [lineX, lineZ] = around(outer + 1.0);
    glow.push(place(new BoxGeometry(5.6, 0.04, 0.04), lineX, DOOR_TOP + 0.67, lineZ, doorAngle));

    const add = (geometries: BufferGeometry[], material: MeshStandardMaterial | typeof cityMaterials.glow) => {
      const mesh = new Mesh(mergeGeometries(geometries), material);
      for (const geometry of geometries) geometry.dispose();
      scene.add(mesh);
      trim.push(mesh);
    };
    add(solid, wallMaterial);
    add(glow, cityMaterials.glow);

    for (const mesh of banners) {
      scene.add(mesh);
      trim.push(mesh);
    }
  }

  /**
   * Every citadel banner, curved onto the inside wall above the
   * galleries: a band of screens under the dome. The set repeats as often as it
   * takes to keep the band no taller than MEDIA_MAX_HEIGHT. The ring still
   * drifts slowly.
   */
  function hangInteriorBanners(radius: number): void {
    if (interiorBannerRing) {
      interiorBannerRing.traverse((obj) => {
        if (obj instanceof Mesh) obj.geometry.dispose();
      });
      interiorBannerRing.removeFromParent();
      interiorBannerRing = null;
    }
    const { platform, explore, discover } = cityMaterials.banners;
    const portraits = [explore, discover];
    // Native aspects, packed edge to edge so the band fills the drum with no gutters.
    const setAspect = portraits.reduce((sum, art) => sum + art.aspect, 0) + platform.aspect * portraits.length;
    const repeats = Math.ceil((Math.PI * 2 * radius) / (setAspect * MEDIA_MAX_HEIGHT));
    const height = (Math.PI * 2 * radius) / (setAspect * repeats);
    const bottom = MEDIA_BOTTOM;
    const ringGroup = new Group();
    ringGroup.name = 'interior-banners';
    ringGroup.rotation.y = interiorBannerAngle;

    const addPanel = (art: (typeof platform), theta0: number, width: number, panelH: number, yBottom: number) => {
      const arc = width / radius;
      const segments = Math.max(16, Math.ceil(arc * 32));
      const pad = 0.08;
      const y = yBottom + panelH / 2;
      const bezel = new Mesh(
        flipInside(new CylinderGeometry(radius - 0.05, radius - 0.05, panelH + pad * 2, segments, 1, true, theta0, arc)),
        innerWallMaterial,
      );
      bezel.position.y = y;
      const screenGeometry = flipInside(new CylinderGeometry(radius - 0.2, radius - 0.2, panelH, segments, 1, true, theta0, arc));
      const uv = screenGeometry.getAttribute('uv');
      for (let j = 0; j < uv.count; j++) uv.setX(j, 1 - uv.getX(j));
      const screen = new Mesh(screenGeometry, art.material);
      screen.position.y = y;
      ringGroup.add(bezel, screen);
    };

    let theta = 0;
    for (let i = 0; i < repeats; i++) {
      portraits.forEach((portrait) => {
        const portraitW = height * portrait.aspect;
        addPanel(portrait, theta, portraitW, height, bottom);
        theta += portraitW / radius;
        const landscapeW = height * platform.aspect;
        addPanel(platform, theta, landscapeW, height, bottom);
        theta += landscapeW / radius;
      });
    }
    scene.add(ringGroup);
    interiorBannerRing = ringGroup;
  }

  /** The towers stand around the citadel, so they follow its width. */
  function buildCity(outer: number): void {
    billboards?.setSlots(billboardSlots);
    ground.scale.setScalar(Math.max(PLAZA_RADIUS, outer + PLAZA_RADIUS / 2));
    // The random door: on the outer wall beside the gate, facing the towers.
    const angle = RANDOM_DOOR_ARC / outer;
    const r = outer + RANDOM_DOOR_OUT;
    randomDoor.place(Math.sin(angle) * r, Math.cos(angle) * r, Math.sin(angle) * r * 2, Math.cos(angle) * r * 2);
  }

  function dispose(): void {
    disposed = true;
    window.clearTimeout(warpTimer);
    window.clearTimeout(privateTimer);
    if (billboardTimer) window.clearInterval(billboardTimer);
    if (occupancyTimer) window.clearInterval(occupancyTimer);
    occupancyFetch?.abort();
    billboardFetch?.abort();
    adModal?.close();
    claimModal?.close();
    billboards?.dispose();
    adPrompt.remove();
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('resize', handleResize);
    renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
    renderer.domElement.removeEventListener('pointerup', handlePointerUp);
    world.dispose();
    for (const door of [...doors.values(), ...emptyDoors, ...galleryDoors, randomDoor]) door.dispose();
    doors.clear();
    emptyDoors.length = 0;
    addPrompt.remove();
    window.removeEventListener('keydown', handleChatKey);
    window.removeEventListener('keydown', handleLiftKey);
    document.removeEventListener('mousemove', holdLook, true);
    document.removeEventListener('wheel', holdLook, true);
    document.documentElement.classList.remove('chatting');
    chatBubble.remove();
    chatBtn?.remove();
    for (const mesh of [...wall, ...trim]) {
      if (mesh.userData.ownMaterial) {
        const material = mesh.material as MeshBasicMaterial;
        material.map?.dispose();
        material.dispose();
      }
      mesh.geometry.dispose();
    }
    if (interiorBannerRing) {
      interiorBannerRing.traverse((obj) => {
        if (obj instanceof Mesh) obj.geometry.dispose();
      });
      interiorBannerRing.removeFromParent();
      interiorBannerRing = null;
    }
    for (const group of gateSeals) group.removeFromParent();
    wallMaterial.dispose();
    innerWallMaterial.dispose();
    gateFrameMaterial.dispose();
    glassMaterial.dispose();
    colliderMaterial.dispose();
    for (const mesh of upper) mesh.geometry.dispose();
    lifts.dispose();
    liftTrim.dispose();
    liftPrompt.remove();
    departures.dispose();
    cityMaterials.dispose();
    sky.geometry.dispose();
    sky.material.dispose();
    spawnRay.dispose();
    assembly.dispose();
    for (const arrival of arrivals) arrival.assembly.dispose();
    ground.geometry.dispose();
    (ground.material as MeshStandardMaterial).dispose();
    mirror.dispose();
    mirror.geometry.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    flash.remove();
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The mirror renders the scene a second time, so draw it at reduced resolution. */
function mirrorResolution(): { textureWidth: number; textureHeight: number } {
  // Phones get a softer reflection: it is the most expensive thing in the scene.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const scale = Math.min(window.devicePixelRatio, 2) * (coarse ? 0.35 : 0.5);
  return {
    textureWidth: Math.max(256, Math.round(window.innerWidth * scale)),
    textureHeight: Math.max(256, Math.round(window.innerHeight * scale)),
  };
}

interface Emerging {
  /** Where the walk out ends. */
  spot: WalkSpot;
  /** The door being walked out of, lit up until they are clear of it. */
  door: Door | null;
  /** Seconds since it started. */
  time: number;
  /** Swing the third-person camera round from the door to behind them. */
  orbit: boolean;
}

interface Ghost {
  /** A slow hologram flicker. Call once per frame. `appear` scales 0–1 during spawn fade-in. */
  shimmer(time: number, appear?: number): void;
  /** Put every material back exactly as it was. */
  restore(): void;
}

/**
 * Turns this visitor's own figure into a see-through, faintly glowing ghost.
 * Only this browser draws it that way: the presence server never hears about
 * it, so everyone else sees an ordinary figure.
 */
const CLAIMS_KEY = 'worldmesh.lobby.claims';

interface ClaimedWorld {
  name: string;
  url: string;
  email: string;
  /** Picture shown in the doorway. */
  cover?: string;
}

interface DoorClaim {
  angle: number;
  /** 0 (or missing) on the hall floor, 1 and 2 on the galleries. */
  level?: number;
  name: string;
  url: string;
  cover?: string;
}

/** What the departures board shows of a world. */
function pick(world: DoorWorld): Omit<Flight, 'gate'> {
  return { name: world.name, cover: world.cover, color: world.color };
}

function angleDelta(a: number, b: number): number {
  const turn = Math.PI * 2;
  const d = Math.abs(a - b) % turn;
  return Math.min(d, turn - d);
}

function loadClaims(): DoorClaim[] {
  try {
    const raw = localStorage.getItem(CLAIMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DoorClaim =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as DoorClaim).angle === 'number' &&
        typeof (entry as DoorClaim).name === 'string' &&
        typeof (entry as DoorClaim).url === 'string' &&
        ((entry as DoorClaim).cover === undefined || typeof (entry as DoorClaim).cover === 'string') &&
        ((entry as DoorClaim).level === undefined || typeof (entry as DoorClaim).level === 'number'),
    );
  } catch {
    return [];
  }
}

function saveClaim(claim: DoorClaim): void {
  const rest = loadClaims().filter(
    (entry) => (angleDelta(entry.angle, claim.angle) >= 0.08 || (entry.level ?? 0) !== (claim.level ?? 0)) && entry.url !== claim.url,
  );
  const next = [...rest, claim];
  try {
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(next));
  } catch {
    // A large graphic can overflow storage. Keep the door without the picture.
    try {
      localStorage.setItem(CLAIMS_KEY, JSON.stringify(next.map(({ cover: _cover, ...entry }) => entry)));
    } catch {
      // Storage blocked: the door still shows the world until the page is left.
    }
  }
}

/**
 * A window inside the lobby for the empty door in front of you. The first
 * person to place a world here keeps that doorway.
 */
function openClaimModal(
  light: boolean,
  options: {
    taken: (url: string) => boolean;
    note?: string;
    onClose: () => void;
    onClaim: (world: ClaimedWorld) => void;
  },
): { close: () => void } {
  const dialog = document.createElement('dialog');
  dialog.className = 'world-claim';
  dialog.setAttribute('aria-labelledby', 'world-claim-title');
  if (light) dialog.dataset.theme = 'light';
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup', 'wheel', 'touchstart']) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }

  const title = document.createElement('h2');
  title.id = 'world-claim-title';
  title.textContent = 'Put your world in this door';
  const note = document.createElement('p');
  note.textContent = options.note ?? 'You are the first one at this door, so you can place your world here. It opens in the lobby right away and is sent to the gallery for review.';
  const status = document.createElement('p');
  status.className = 'world-claim-status';

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://your-world.example';
  urlInput.autocomplete = 'off';
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.required = true;
  emailInput.placeholder = 'Email, so you can manage it';
  emailInput.autocomplete = 'email';

  const coverSection = document.createElement('div');
  coverSection.className = 'cover-section';
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.accept = 'image/*';
  coverInput.hidden = true;
  const coverTrigger = document.createElement('button');
  coverTrigger.type = 'button';
  coverTrigger.className = 'cover-upload-trigger';
  coverTrigger.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>Add cover image (optional, portrait 3:4)</span>';
  const cropperBox = document.createElement('div');
  cropperBox.className = 'cropper-container';
  cropperBox.style.display = 'none';
  const previewCard = document.createElement('div');
  previewCard.className = 'cropper-preview-card';
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const hint = document.createElement('div');
  hint.className = 'cropper-overlay-hint';
  hint.textContent = 'Drag to move · Scroll to zoom';
  previewCard.append(canvas, hint);
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'cropper-icon-btn';
  zoomOut.title = 'Zoom out';
  zoomOut.textContent = '−';
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'cropper-icon-btn';
  zoomIn.title = 'Zoom in';
  zoomIn.textContent = '+';
  const zoomSlider = document.createElement('input');
  zoomSlider.type = 'range';
  zoomSlider.min = '1';
  zoomSlider.max = '3';
  zoomSlider.step = '0.01';
  zoomSlider.value = '1';
  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'cropper-zoom-group';
  zoomGroup.append(zoomOut, zoomSlider, zoomIn);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'cropper-text-btn';
  reset.textContent = 'Reset';
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'cropper-text-btn';
  change.textContent = 'Change';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cropper-text-btn danger';
  remove.textContent = 'Remove';
  const cropActions = document.createElement('div');
  cropActions.className = 'cropper-actions';
  cropActions.append(reset, change, remove);
  const toolbar = document.createElement('div');
  toolbar.className = 'cropper-toolbar';
  toolbar.append(zoomGroup, cropActions);
  cropperBox.append(previewCard, toolbar);
  coverSection.append(coverInput, coverTrigger, cropperBox);

  const cropper = new ImageCropper(canvas, {
    onZoomChange: (zoom) => {
      zoomSlider.value = String(zoom);
    },
    onImageLoaded: () => {
      cropperBox.style.display = 'flex';
      coverTrigger.style.display = 'none';
      zoomSlider.value = '1';
    },
    onClear: () => {
      cropperBox.style.display = 'none';
      coverTrigger.style.display = '';
      coverInput.value = '';
    },
  });
  const loadCoverFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      status.textContent = 'Please select an image file.';
      return;
    }
    void cropper.loadFile(file).then(
      () => {
        status.textContent = '';
      },
      () => {
        status.textContent = 'Failed to load image. Please try another one.';
      },
    );
  };
  coverTrigger.addEventListener('click', () => coverInput.click());
  change.addEventListener('click', () => coverInput.click());
  coverInput.addEventListener('change', () => loadCoverFile(coverInput.files?.[0]));
  zoomSlider.addEventListener('input', () => cropper.setZoom(parseFloat(zoomSlider.value)));
  zoomIn.addEventListener('click', () => cropper.setZoom(cropper.getZoom() + 0.25));
  zoomOut.addEventListener('click', () => cropper.setZoom(cropper.getZoom() - 0.25));
  reset.addEventListener('click', () => cropper.resetTransform());
  remove.addEventListener('click', () => cropper.clear());
  for (const dropTarget of [coverTrigger, cropperBox]) {
    dropTarget.addEventListener('dragover', (event) => {
      event.preventDefault();
      coverTrigger.classList.add('drag-over');
    });
    dropTarget.addEventListener('dragleave', () => coverTrigger.classList.remove('drag-over'));
    dropTarget.addEventListener('drop', (event) => {
      event.preventDefault();
      coverTrigger.classList.remove('drag-over');
      loadCoverFile(event.dataTransfer?.files?.[0]);
    });
  }

  const frame = document.createElement('iframe');
  frame.className = 'world-claim-frame';
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
  frame.title = 'Preview of your world';

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.textContent = 'Look inside';
  const claim = document.createElement('button');
  claim.type = 'button';
  claim.className = 'world-claim-primary';
  claim.textContent = 'Place it here';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'world-claim-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';

  const actions = document.createElement('div');
  actions.className = 'world-claim-actions';
  actions.append(preview, claim);
  dialog.append(closeButton, title, note, urlInput, emailInput, coverSection, status, frame, actions);
  document.body.appendChild(dialog);
  window.dispatchEvent(new Event('blur'));
  dialog.showModal();
  urlInput.focus();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    options.onClose();
  };
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  const readUrl = (): URL | null => {
    const raw = urlInput.value.trim();
    if (!raw) return null;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
  };

  preview.addEventListener('click', () => {
    const url = readUrl();
    if (!url) {
      status.textContent = 'That does not look like a URL.';
      return;
    }
    status.textContent = '';
    frame.hidden = false;
    frame.src = url.toString();
  });

  claim.addEventListener('click', () => {
    const url = readUrl();
    const email = emailInput.value.trim();
    if (!url) {
      status.textContent = 'That does not look like a URL.';
      return;
    }
    if (options.taken(url.toString())) {
      status.textContent = 'That world already has a door.';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      status.textContent = 'Enter an email so you can manage this world.';
      return;
    }
    const picture = cropper.hasImage() ? cropper.exportWebP(0.82) : '';
    options.onClaim({ name: url.hostname, url: url.toString(), email, cover: picture || undefined });
    close();
  });

  return { close };
}

function makeGhost(root: Object3D | null): Ghost | null {
  if (!root) return null;
  const saved = new Map<Material, { opacity: number; transparent: boolean; depthWrite: boolean; emissive?: number }>();
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (saved.has(material)) continue;
      const standard = material instanceof MeshStandardMaterial ? material : null;
      saved.set(material, {
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        emissive: standard?.emissive.getHex(),
      });
      material.transparent = true;
      // Let the far side of the body show through, like a hologram.
      material.depthWrite = false;
      standard?.emissive.set(GHOST_GLOW);
      material.needsUpdate = true;
    }
  });
  const shimmer = (time: number, appear = 1) => {
    const opacity = (GHOST_OPACITY + Math.sin(time * 3.1) * Math.sin(time * 7.3) * GHOST_SHIMMER) * appear;
    for (const material of saved.keys()) {
      // The drawn-on face stays a little clearer than the body. The outline fades with the body.
      material.opacity = isStrokeMaterial(material)
        ? opacity
        : material instanceof MeshBasicMaterial
          ? Math.min(1, opacity * 1.8)
          : opacity;
    }
    // A stroke added after the ghost was made is not in `saved`.
    root.traverse((child) => {
      if (!(child instanceof Mesh) || !isStrokeMaterial(child.material as Material)) return;
      const material = child.material as Material;
      if (saved.has(material)) return;
      material.transparent = true;
      material.depthWrite = false;
      material.opacity = opacity;
    });
  };
  shimmer(0);
  return {
    shimmer,
    restore: () => {
      for (const [material, was] of saved) {
        material.opacity = was.opacity;
        material.transparent = was.transparent;
        material.depthWrite = was.depthWrite;
        if (was.emissive !== undefined && material instanceof MeshStandardMaterial) material.emissive.setHex(was.emissive);
        material.needsUpdate = true;
      }
      saved.clear();
      root.traverse((child) => {
        if (!(child instanceof Mesh) || !isStrokeMaterial(child.material as Material)) return;
        const material = child.material as Material;
        material.opacity = 1;
        material.transparent = false;
        material.depthWrite = true;
        material.needsUpdate = true;
      });
    },
  };
}

/** Fill the local figure in from scattered points. Custom avatars fade instead. */
function setLocalAppear(root: Object3D | null, amount: number): void {
  if (!root) return;
  setStrokeOpacity(root, amount);
  if (setAvatarAppear(root, amount)) return;
  const solid = amount >= 0.999;
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      const face = material instanceof MeshBasicMaterial;
      material.transparent = face || !solid;
      material.opacity = amount;
      material.depthWrite = !face && solid;
      material.needsUpdate = true;
    }
  });
}

const ALIAS_WORDS = [
  ['Quiet', 'Swift', 'Silver', 'Hidden', 'Misty', 'Gentle', 'Lucky', 'Sleepy', 'Brave', 'Distant', 'Wandering', 'Pale', 'Amber', 'Velvet', 'Cosmic', 'Lunar'],
  ['Fox', 'Owl', 'Comet', 'Otter', 'Moth', 'Heron', 'Lynx', 'Raven', 'Koala', 'Falcon', 'Badger', 'Nomad', 'Shadow', 'Echo', 'Pebble', 'Drifter'],
];

/** A made-up name such as 'Quiet Fox'. Matches the presence server's alias rule. */
function randomAlias(): string {
  const pick = (words: string[]) => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick(ALIAS_WORDS[0])} ${pick(ALIAS_WORDS[1])}`;
}

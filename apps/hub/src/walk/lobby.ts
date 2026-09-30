import { AVATAR_TICKET_PARAM, buildTravelUrl, createWorldMesh, type Vec3Tuple } from '@worldmesh/runtime';
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_GLOW_WHITE, SKY_HORIZON, applyCityTheme, createCityMaterials, createSky, flipInside } from './city';
import { Presence } from './presence';
import { DOOR_HALF_SPAN, DOOR_TOP, Door, type DoorWorld } from './door';
import { describeBillboard } from './layout';
import { fetchBillboards } from '../ads/api';
import { AdBillboards, type BillboardHit } from '../ads/billboards';
import { AD_CONFIG, normalizeDestinationUrl } from '../ads/config';
import { openAdModal } from '../ads/modal';
import type { SignalSource } from '../discovery/ranking';
import { TowerCity } from '../towers/towerCity';
import type { WorldRecordInput } from '../worlds/listing';

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
   * Mount the billboard ads UI (outlines, +, prompts, modal, live ads).
   * Off by default; pass true only when ads are deliberately enabled
   * (`AD_CONFIG.enabled` / `VITE_ADS_ENABLED`).
   */
  ads?: boolean;
  /** Visit counts and the like, for ranking worlds in the towers. */
  signals?: SignalSource;
}

export interface Lobby {
  /** Add doors (and tower listings) for worlds that were not listed yet. */
  setWorlds(worlds: LobbyWorld[]): void;
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
  /** The made-up name while private, or null while public. */
  readonly alias: string | null;
  dispose(): void;
}

/** Objects on this layer are drawn by the main camera but not seen in the floor mirror. */
const FLOOR_LAYER = 1;
const FLOOR_SIZE = 600;
/** The citadel: never narrower than this, and grows so doors keep this much wall between them. */
const WALL_MIN_RADIUS = 11;
const DOOR_SPACING = 4.2;
/** A tall drum open to the sky, with the doors around the inside of its base. */
const CITADEL_HEIGHT = 30;
const WALL_THICKNESS = 1.2;
/** The way out to the city faces +Z: straight behind you when you arrive. */
const GATE_WIDTH = 4.4;
const GATE_HEIGHT = 6.2;
/** Wall kept clear on each side of the gate before the first door. */
const GATE_MARGIN = DOOR_SPACING;
/** The hall always has at least this many doors, and always a few empty ones. */
const MIN_DOORS = 24;
const SPARE_DOORS = 6;
/** Stand this close in front of an empty door to be offered it. */
const EMPTY_DOOR_REACH = 2.4;
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
/** Where every visitor arrives: the middle of the hall, facing the doors. */
const SPAWN: Vec3Tuple = [0, 0, 0];
/** How long the screen stays white while switching in or out of private mode. */
const PRIVATE_FADE_MS = 260;
/** The ghost's opacity, and how far its shimmer swings either side of it. */
const GHOST_OPACITY = 0.38;
const GHOST_SHIMMER = 0.08;
const GHOST_GLOW = 0x5cc8ff;
/** Billboards further than this are not picked by the crosshair or a tap. */
const BILLBOARD_RANGE = 95;
/** How often the billboard under the crosshair is looked up, in seconds. */
const FOCUS_INTERVAL = 0.1;
/** Billboard bookings are refreshed this often while walking. */
const BILLBOARD_REFRESH_MS = 60_000;
/** The random door stands on the citadel's outer wall, this far along it from the gate. */
const RANDOM_DOOR_ARC = 4.1;
/** How far the random door stands out from the outer wall. */
const RANDOM_DOOR_OUT = 0.3;

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
    varying vec4 vUv;
    varying vec3 vWorld;

    #include <logdepthbuf_pars_fragment>

    float gridLine(vec2 coord) {
      vec2 g = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), vec2(1e-4));
      return 1.0 - min(min(g.x, g.y), 1.0);
    }

    void main() {
      #include <logdepthbuf_fragment>

      vec3 reflection = texture2DProj(tDiffuse, vUv).rgb;

      float minor = gridLine(vWorld.xz / 2.0);
      float major = gridLine(vWorld.xz / 10.0);
      // Fade out well before the horizon, where dense lines would add up to a bright band.
      float dist = distance(vWorld.xz, cameraPosition.xz);
      float fade = 1.0 - smoothstep(12.0, 75.0, dist);
      float minorFade = 1.0 - smoothstep(8.0, 40.0, dist);
      // Lines light up a little around the player.
      float glow = 1.0 - smoothstep(0.0, 14.0, distance(vWorld.xz, uPlayer));
      float lines = max(minor * 0.08 * minorFade, major * 0.2) * fade * (1.0 + glow * 1.6);

      // A mirror under a tinted glaze: glossier at grazing angles, faint
      // looking straight down.
      vec3 toCamera = normalize(cameraPosition - vWorld);
      float glaze = mix(0.6, 0.88, abs(toCamera.y));

      // Dark: black glass with light lines. Light: white glass with ink lines.
      vec3 darkFloor = reflection * (1.0 - glaze) * (1.0 - lines) + vec3(lines);
      vec3 lightFloor = mix(reflection, uBackground, glaze) * (1.0 - min(lines * 1.4, 1.0));

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
 * one travels to that world. A gate leads out to a plaza ringed by towers. Movement,
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

  const wallMaterial = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.7, metalness: 0 });
  const cityMaterials = createCityMaterials(renderer.capabilities.getMaxAnisotropy());
  let disposed = false;
  // Screen lettering uses the page font, which may still be loading.
  document.fonts?.load('700 100px Urbanist').then(() => {
    if (!disposed) cityMaterials.redraw();
  }, () => {});
  const mirror = new Reflector(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
    shader: floorShader,
    ...mirrorResolution(),
  });
  mirror.rotation.x = -Math.PI / 2;
  scene.add(mirror);
  const floorUniforms = (mirror.material as ShaderMaterial).uniforms;
  // Up on a bridge or inside a tower the mirror would only cost a second
  // render of the scene: a plain floor stands in for it there.
  const plainFloor = new Mesh(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2), new MeshBasicMaterial());
  plainFloor.position.y = -0.02;
  plainFloor.visible = false;
  scene.add(plainFloor);
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

  // The category towers around the plaza: floors of doors, elevators, bridges.
  const towerCity = new TowerCity({
    scene,
    camera,
    container,
    light,
    touch: isTouch,
    interiorLayer: FLOOR_LAYER,
    signals: options.signals,
    onEnterWorld: (listing, returnTo) =>
      travel({ name: listing.name, url: listing.url, cover: listing.cover, color: listing.color, creator: listing.creator.name }, returnTo, null),
  });

  // Billboard ads: only mount when deliberately enabled (off by default) and the city has screens for them.
  const adsEnabled = options.ads === true && towerCity.billboards.length > 0;
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
    ? new Presence(
        options.presenceEndpoint,
        'lobby',
        scene,
        (count) => options.onPresenceCount?.(count),
        () => (alias ? null : options.playerName?.() ?? null),
        () => alias,
      )
    : undefined;

  // The citadel's walls (solid) and trim (just for looks). Rebuilt whenever
  // the door count changes.
  const wall: Mesh[] = [];
  const trim: Mesh[] = [];
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
  // Outside, set into the tower beside the gate: a glowing blue door to a
  // random listed world.
  const randomDoor = new Door(null, light, true);
  scene.add(randomDoor.group);
  let nearEmpty: Door | null = null;
  let adding = false;
  let time = 0;
  let warping = false;
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
  addPrompt.textContent = isTouch ? 'Tap to add your world here' : 'Press E or click to add your world here';
  addPrompt.addEventListener('click', (event) => {
    event.stopPropagation();
    addWorld();
  });
  container.appendChild(addPrompt);

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
  let billboardFetch: AbortController | null = null;

  const world = createWorldMesh({
    scene,
    camera,
    renderer,
    spawn: SPAWN,
    // Held upright, look further down so the floor fills the tall screen instead of the sky.
    view: { mode: 'third', distance: 5.5, pitch: window.innerWidth < window.innerHeight ? -0.32 : -0.15 },
    ui: { title: 'WorldMesh', badge: false, crosshair: false },
    network: presence,
    // Empty doors are closed: their faces stop you like the wall does.
    colliders: () => [
      ground,
      ...wall,
      ...emptyDoors.map((door) => door.face),
      ...(exitDoor ? [exitDoor.face] : []),
      ...towerCity.colliders(),
    ],
    onUpdate: (dt, handle) => {
      time += dt;
      if (emerging) stepEmerging(dt);
      towerCity.setBlocked(warping || emerging !== null || adModal !== null);
      towerCity.update(dt);
      const [x, , z] = handle.getState().position;
      if (exitDoor && !emerging) {
        const { x: doorX, z: doorZ } = exitDoor.inFront(0);
        if (Math.hypot(x - doorX, z - doorZ) > EXIT_CLEAR) setExitDoor(null);
      }
      for (const door of [...doors.values(), randomDoor]) {
        door.update(time);
        if (!warping && !emerging && door.contains(x, z)) enter(door);
      }
      let near: Door | null = null;
      let nearest = EMPTY_DOOR_REACH;
      for (const door of emptyDoors) {
        door.update(time);
        const distance = door.distanceInFront(x, z);
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
      // The sky is centred on the camera, so it stays around it however high the towers take them.
      sky.position.copy(camera.position);
      // Keep the finite floor under the player. The grid is drawn in world
      // space, so moving the plane does not move the lines.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      mirror.visible = towerCity.wantsMirror;
      plainFloor.visible = !mirror.visible;
      plainFloor.position.x = mirror.position.x;
      plainFloor.position.z = mirror.position.z;
      presence?.update(dt);
      ghost?.shimmer(time);
    },
  });
  if (alias) ghost = makeGhost(world.avatar);
  towerCity.attach(world);

  /** Walking through a lobby door: flash, then travel to the world's own URL. */
  function enter(door: Door): void {
    const target = door.random ? pickRandomWorld() : door.world;
    if (!target) return;
    door.surge();
    const out = door.inFront(RETURN_STEP);
    travel(target, { position: [out.x, 0, out.z], yaw: out.yaw }, door);
  }

  /**
   * Into a world, from a lobby door or a tower door: flash, then go to its
   * own URL. `spot` is where to come back out.
   */
  function travel(target: DoorWorld, spot: WalkSpot, door: Door | null): void {
    if (warping) return;
    warping = true;
    warpDoor = door;
    towerCity.setBlocked(true);
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
      if (parsed.hash.startsWith(`#${AVATAR_TICKET_PARAM}=`)) parsed.hash = '';
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function pickRandomWorld(): DoorWorld | null {
    const worlds = [...known.values()];
    return worlds.length ? worlds[Math.floor(Math.random() * worlds.length)] : null;
  }

  /** An empty door was picked: hand over to the page's add-world form. */
  function addWorld(): void {
    if (adding || warping) return;
    adding = true;
    document.exitPointerLock?.();
    // E arrives mid-frame, and the page may tear the lobby down in response:
    // let the frame finish drawing first.
    window.setTimeout(() => options.onAddWorld?.(), 0);
  }

  // Keyboard: E at a tower door, lift or elevator, or next to an empty door.
  // The runtime reports E as a plain interaction when no portal of its own is in reach.
  world.on('interact', () => {
    if (towerCity.interact()) return;
    if (nearEmpty) addWorld();
  });

  // Pointer: clicking or tapping a tower door or a billboard. While the mouse
  // is captured there is no cursor, so a click aims where the camera looks.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pressAt: { x: number; y: number; time: number } | null = null;
  const handlePointerDown = (event: PointerEvent) => {
    pressAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    if (document.pointerLockElement !== renderer.domElement || adModal || event.button !== 0) return;
    // A click aims where the camera looks: a tower door there, or a billboard.
    if (towerCity.tap(0, 0)) return;
    const hit = billboardAt(0, 0);
    if (hit) activateBillboard(hit);
  };
  const handlePointerUp = (event: PointerEvent) => {
    const press = pressAt;
    pressAt = null;
    if (!press || document.pointerLockElement === renderer.domElement || adModal) return;
    // A tap, not a drag to look around or a push on the joystick.
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 10 || performance.now() - press.time > 400) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    if (towerCity.tap(ndcX, ndcY)) return;
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
    const active = !adModal && !warping && !doorPrompt && (document.pointerLockElement === renderer.domElement || isTouch);
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
    towerCity.setBlocked(false);
    adding = false;
    flash.classList.remove('active');
    if (returnTo) emerge(returnTo);
    else world.respawn();
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

  if (import.meta.env.DEV) Object.assign(window, { lobby: world });

  return {
    setWorlds,
    setTheme,
    setPrivate,
    get alias() {
      return pendingAlias;
    },
    dispose,
  };

  /** Come back out of the door behind `spot`, walking a few steps into the hall. */
  function emerge(spot: WalkSpot): void {
    const [x, , z] = spot.position;
    // Up in a tower: stream in that floor before standing on it.
    towerCity.syncTo(spot.position);
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
      presence?.rejoin();
      flash.classList.remove('active');
    }, PRIVATE_FADE_MS);
    return next;
  }

  function setTheme(isLight: boolean): void {
    if (isLight === light) return;
    light = isLight;
    applyTheme();
    for (const door of [...doors.values(), ...emptyDoors, randomDoor]) door.setTheme(light);
    towerCity.setTheme(light);
  }

  function applyTheme(): void {
    // Light: a plain blue sky over pale towers. Dark: black, lit by the towers' windows and doors.
    // The fog reaches past the towers so they read across the plaza, and swallows their tops.
    background.set(light ? SKY_HORIZON : 0x000000);
    renderer.setClearColor(background);
    sky.visible = light;
    fog.color.copy(background);
    fog.near = light ? 70 : 45;
    fog.far = light ? 300 : 230;
    hemisphere.groundColor.set(light ? 0xdde5f2 : 0x202020);
    hemisphere.intensity = light ? 2 : 1.6;
    floorUniforms.uBackground.value.set(light ? 0xf1f4fa : 0x000000);
    floorUniforms.uHaze.value.copy(background);
    floorUniforms.uLight.value = light ? 1 : 0;
    wallMaterial.color.set(light ? 0xf5f6fa : 0x141418);
    // Lift the shaded sides so white stays white, not grey.
    wallMaterial.emissive.set(light ? CITY_GLOW_WHITE : 0x000000);
    applyCityTheme(cityMaterials, light);
    (plainFloor.material as MeshBasicMaterial).color.set(light ? 0xf1f4fa : 0x000000);
    billboards?.setTheme(light);
  }

  function setWorlds(worlds: LobbyWorld[]): void {
    towerCity.setWorlds(worlds);
    for (const entry of worlds) {
      if (!known.has(entry.url)) known.set(entry.url, entry);
    }

    // Everyone with the same list gets the same ring, so visitors who see
    // each other also see the same doors around them.
    const urls = [...known.keys()].sort();
    const total = Math.max(MIN_DOORS, urls.length + SPARE_DOORS);
    const radius = Math.max(WALL_MIN_RADIUS, (total * DOOR_SPACING + GATE_WIDTH + GATE_MARGIN * 2) / (Math.PI * 2));
    // Doors share the wall evenly, leaving the gate at angle 0 clear.
    const clear = (GATE_WIDTH / 2 + GATE_MARGIN) / radius;
    const step = (Math.PI * 2 - clear * 2) / total;
    const angles = Array.from({ length: total }, (_, i) => clear + (i + 0.5) * step);
    // Worlds take the doors you face on arrival (angle π) and spread out from
    // there toward the gate; the doors left over stay empty.
    const slots = angles
      .map((_, i) => i)
      .sort((a, b) => Math.abs(angles[a] - Math.PI) - Math.abs(angles[b] - Math.PI) || a - b);
    const at = (door: Door, slot: number) =>
      // Set into the wall, facing the middle of the room.
      door.place(Math.sin(angles[slot]) * radius, Math.cos(angles[slot]) * radius, 0, 0);

    urls.forEach((url, i) => {
      let door = doors.get(url);
      if (!door) {
        door = new Door(known.get(url)!, light);
        scene.add(door.group);
        doors.set(url, door);
      }
      at(door, slots[i]);
    });

    for (const door of emptyDoors) door.dispose();
    emptyDoors.length = 0;
    nearEmpty = null;
    addPrompt.classList.remove('visible');
    for (const slot of slots.slice(urls.length)) {
      const door = new Door(null, light);
      scene.add(door.group);
      at(door, slot);
      emptyDoors.push(door);
    }
    buildWall(radius, angles);
  }

  /**
   * The citadel: an inner and an outer drum with the doorways cut into the
   * inner one and the gate cut through both, then trim, the banner over the
   * gate, and the city around it.
   */
  function buildWall(radius: number, angles: number[]): void {
    for (const mesh of [...wall, ...trim]) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    wall.length = 0;
    trim.length = 0;
    const outer = radius + WALL_THICKNESS;

    const shell = (r: number, start: number, length: number, bottom: number, inward: boolean) => {
      if (length <= 0) return;
      const height = CITADEL_HEIGHT - bottom;
      const segments = Math.max(2, Math.ceil(length * 24));
      const geometry = new CylinderGeometry(r, r, height, segments, 1, true, start, length);
      const section = new Mesh(inward ? flipInside(geometry) : geometry, wallMaterial);
      section.position.y = bottom + height / 2;
      scene.add(section);
      wall.push(section);
    };

    // Inner drum: faces the hall, open at the gate and at every doorway.
    const openings = [
      { angle: 0, half: GATE_WIDTH / 2 / radius, top: GATE_HEIGHT },
      ...angles.map((angle) => ({ angle, half: DOOR_HALF_SPAN / radius, top: DOOR_TOP })),
    ];
    openings.forEach((opening, i) => {
      const next = openings[i + 1] ?? { ...openings[0], angle: openings[0].angle + Math.PI * 2 };
      const start = opening.angle + opening.half;
      shell(radius, start, next.angle - next.half - start, 0, true);
      // Close the wall over the opening.
      shell(radius, opening.angle - opening.half, opening.half * 2, opening.top, true);
    });

    // Outer drum: faces the city, open only at the gate.
    const gateOuter = GATE_WIDTH / 2 / outer;
    shell(outer, gateOuter, Math.PI * 2 - gateOuter * 2, 0, false);
    shell(outer, -gateOuter, gateOuter * 2, GATE_HEIGHT, false);

    // The gate passage: side walls and a ceiling between the two drums.
    const halfGate = GATE_WIDTH / 2;
    const passageStart = Math.sqrt(radius * radius - halfGate * halfGate) - 0.05;
    const passageDepth = outer + 0.05 - passageStart;
    const passageZ = passageStart + passageDepth / 2;
    const block = (w: number, h: number, d: number, x: number, y: number, z: number, solid: boolean) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), wallMaterial);
      mesh.position.set(x, y + h / 2, z);
      scene.add(mesh);
      (solid ? wall : trim).push(mesh);
      return mesh;
    };
    for (const side of [-1, 1]) block(0.4, GATE_HEIGHT, passageDepth, side * (halfGate + 0.1), 0, passageZ, true);
    block(GATE_WIDTH + 0.4, 0.2, passageDepth, 0, GATE_HEIGHT, passageZ, false);

    buildTrim(radius, outer);
    buildCity(outer);
    world.refreshColliders();
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

    // Vertical ribs all round the outside, leaving the gate and banner bare.
    const bare = 5 / outer;
    const ribCount = Math.round((Math.PI * 2 * outer) / 3.2);
    for (let i = 0; i < ribCount; i++) {
      const angle = (i / ribCount) * Math.PI * 2;
      if (angle < bare || angle > Math.PI * 2 - bare) continue;
      const r = outer + 0.2;
      solid.push(place(new BoxGeometry(0.5, CITADEL_HEIGHT, 0.4), Math.sin(angle) * r, CITADEL_HEIGHT / 2, Math.cos(angle) * r, angle));
    }

    // Crown: a cornice around the top and a rim over the wall.
    solid.push(place(new CylinderGeometry(outer + 0.5, outer + 0.5, 1.2, 128, 1, true), 0, CITADEL_HEIGHT - 0.6, 0));
    const rim = new RingGeometry(radius, outer + 0.5, 128);
    rim.rotateX(-Math.PI / 2);
    solid.push(place(rim, 0, CITADEL_HEIGHT, 0));

    // Light bands: outside above the gate and under the crown, inside above
    // the door labels (broken at the gate) and near the top.
    const band = (r: number, y: number, start = 0, length = Math.PI * 2) =>
      glow.push(place(new CylinderGeometry(r, r, 0.07, 128, 1, true, start, length), 0, y, 0));
    band(outer + 0.03, GATE_HEIGHT + 1.2);
    band(outer + 0.52, CITADEL_HEIGHT - 1.3);
    const gateInner = (GATE_WIDTH / 2 + 0.3) / radius;
    band(radius - 0.03, DOOR_TOP + 1.7, gateInner, Math.PI * 2 - gateInner * 2);
    band(radius - 0.03, CITADEL_HEIGHT - 1);

    // A white portal frame around the gate, outlined in light.
    const halfGate = GATE_WIDTH / 2;
    const frameZ = outer + 0.2;
    for (const side of [-1, 1]) {
      solid.push(place(new BoxGeometry(0.6, GATE_HEIGHT + 0.6, 0.5), side * (halfGate + 0.3), (GATE_HEIGHT + 0.6) / 2, frameZ));
      glow.push(place(new BoxGeometry(0.05, GATE_HEIGHT, 0.05), side * (halfGate + 0.02), GATE_HEIGHT / 2, frameZ + 0.2));
    }
    solid.push(place(new BoxGeometry(GATE_WIDTH + 1.2, 0.6, 0.5), 0, GATE_HEIGHT + 0.3, frameZ));
    glow.push(place(new BoxGeometry(GATE_WIDTH, 0.05, 0.05), 0, GATE_HEIGHT - 0.02, frameZ + 0.2));

    // The banner over the gate: a tall screen in a deep white bezel, deep
    // enough to meet the curved wall behind it.
    const bannerW = 7;
    const bannerH = 14;
    const bannerBottom = GATE_HEIGHT + 2.4;
    solid.push(place(new BoxGeometry(bannerW + 0.6, bannerH + 0.6, 1.4), 0, bannerBottom + bannerH / 2, outer - 0.35));
    glow.push(place(new BoxGeometry(bannerW + 0.6, 0.05, 0.05), 0, bannerBottom - 0.35, outer + 0.36));

    // The random door's backing and porch, on the outer wall beside the gate.
    const doorAngle = RANDOM_DOOR_ARC / outer;
    const around = (r: number) => [Math.sin(doorAngle) * r, Math.cos(doorAngle) * r] as const;
    const [backX, backZ] = around(outer - 0.05);
    solid.push(place(new BoxGeometry(2.4, DOOR_TOP + 2.2, 0.5), backX, (DOOR_TOP + 2.2) / 2, backZ, doorAngle));
    const [porchX, porchZ] = around(outer + 0.55);
    solid.push(place(new BoxGeometry(2.4, 0.16, 0.9), porchX, DOOR_TOP + 0.75, porchZ, doorAngle));
    const [lineX, lineZ] = around(outer + 1.0);
    glow.push(place(new BoxGeometry(2.4, 0.04, 0.04), lineX, DOOR_TOP + 0.67, lineZ, doorAngle));

    const add = (geometries: BufferGeometry[], material: MeshStandardMaterial | typeof cityMaterials.glow) => {
      const mesh = new Mesh(mergeGeometries(geometries), material);
      for (const geometry of geometries) geometry.dispose();
      scene.add(mesh);
      trim.push(mesh);
    };
    add(solid, wallMaterial);
    add(glow, cityMaterials.glow);

    const banner = new Mesh(new PlaneGeometry(bannerW, bannerH), cityMaterials.citadelPoster.material);
    banner.position.set(0, bannerBottom + bannerH / 2, outer + 0.37);
    scene.add(banner);
    trim.push(banner);
  }

  /** The towers stand around the citadel, so they follow its width. */
  function buildCity(outer: number): void {
    towerCity.layout(outer);
    billboards?.setSlots([...towerCity.billboards]);
    ground.scale.setScalar(towerCity.groundRadius + 2);
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
    billboardFetch?.abort();
    towerCity.dispose();
    adModal?.close();
    billboards?.dispose();
    adPrompt.remove();
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('resize', handleResize);
    renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
    renderer.domElement.removeEventListener('pointerup', handlePointerUp);
    world.dispose();
    for (const door of [...doors.values(), ...emptyDoors, randomDoor]) door.dispose();
    doors.clear();
    emptyDoors.length = 0;
    addPrompt.remove();
    for (const mesh of [...wall, ...trim]) mesh.geometry.dispose();
    wallMaterial.dispose();
    cityMaterials.dispose();
    plainFloor.geometry.dispose();
    (plainFloor.material as MeshBasicMaterial).dispose();
    sky.geometry.dispose();
    sky.material.dispose();
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
  /** A slow hologram flicker. Call once per frame. */
  shimmer(time: number): void;
  /** Put every material back exactly as it was. */
  restore(): void;
}

/**
 * Turns this visitor's own figure into a see-through, faintly glowing ghost.
 * Only this browser draws it that way: the presence server never hears about
 * it, so everyone else sees an ordinary figure.
 */
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
  const shimmer = (time: number) => {
    const opacity = GHOST_OPACITY + Math.sin(time * 3.1) * Math.sin(time * 7.3) * GHOST_SHIMMER;
    for (const material of saved.keys()) {
      // The drawn-on face stays a little clearer than the body.
      material.opacity = material instanceof MeshBasicMaterial ? Math.min(1, opacity * 1.8) : opacity;
    }
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
    },
  };
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

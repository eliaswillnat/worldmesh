import {
  buildTravelUrl,
  createWorldMesh,
  setAvatarAppear,
  setAvatarColor,
  setStrokeOpacity,
  type Vec3Tuple,
} from '@worldmesh/runtime';
import {
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_GLOW_WHITE, applyCityTheme, applySkyTheme, createCityMaterials, createSky, skyHorizon, updateSky } from './city';
import { Door, type DoorWorld } from './door';
import { LiveDoors } from './liveDoors';
import { WalkThrough } from './walkThrough';
import { buildAvenues } from './avenues';
import { planStreet, type StreetPlan } from './streetPlan';
import { playWarpSound, silence } from './sounds';
import { Arrival } from './arrival';
import { canonicalUrl } from '../worlds/listing';

/** A place in the lobby and the way to face there. */
export interface WalkSpot {
  position: Vec3Tuple;
  yaw: number;
}

/** A listed world: what its door needs. */
export type LobbyWorld = DoorWorld;

export interface LobbyOptions {
  worlds: LobbyWorld[];
  /** Walk out of the door behind this spot instead of starting at the top of the street. */
  start?: WalkSpot | null;
  /**
   * The world a visitor came back from through its lobby portal (`from` in
   * the address): they walk out of its door, if it has one here. Drawn in
   * that portal (`doorwayView`), the lobby is seen from that door.
   */
  from?: string | null;
  /**
   * Drawn live in a world's lobby portal (Doorway §3.1, `?doorway-view`):
   * the runtime draws the views the world sends. The lobby makes no sound,
   * opens no live doors of its own and never travels.
   */
  doorwayView?: boolean;
  /** Draw the lobby white instead of black. */
  light?: boolean;
  /** Default-character tint. Forgotten on refresh; only a return from a world restores it. */
  color?: string | null;
  /**
   * Called every frame with where this visitor stands (feet), measured from
   * the middle of the street, and how far the street reaches from there.
   */
  onListener?: (x: number, y: number, z: number, reach: number) => void;
  /**
   * Called right before the page navigates into a world, with where to put
   * the visitor if they come back: just outside that door, facing the street.
   */
  onEnterWorld?: (world: DoorWorld, returnTo: WalkSpot) => void;
  /** How many times people have entered a world, by URL; shown beside its doors. */
  entries?: (url: string) => number | undefined;
}

export interface Lobby {
  /** Add doors for worlds that were not listed yet. */
  setWorlds(worlds: LobbyWorld[]): void;
  /** Entry counts changed: update the numbers beside every door. */
  refreshEntries(): void;
  /**
   * Switch between the dark and light lobby. Purely local: it only changes
   * how this browser draws the street.
   */
  setTheme(light: boolean): void;
  /** Tint the default character. */
  setColor(color: string): void;
  dispose(): void;
}

const FLOOR_SIZE = 600;
/** Seconds from stepping into a door to the page going to its world. */
const WARP_MS = 450;
/** How much wider the lens pulls going through a door, in degrees. */
const LENS_FOV = 55;
/** Seconds the lens takes to settle back coming out of a door. */
const LENS_OUT_S = 0.7;
/** Seconds the warp out of the lobby takes to play. */
const LEAVE_TIME = 0.12;
/** How far out of a door someone comes back, in metres. */
const RETURN_STEP = 2.4;
/** In a world's lobby portal: how far in front of that world's door the lobby is seen from. */
const VIEW_STEP = 0.6;
/** Coming back out, the walk starts this far inside the doorway and takes this long. */
const WALK_OUT_FROM = -0.6;
const WALK_OUT_S = 1.5;
/** The white flash stays up this long before the lens starts to settle. */
const FLASH_HOLD_S = 0.1;
/** The third-person camera turns round from the door to behind the visitor, from this long into the walk, over this long. */
const TURN_FROM_S = 1.1;
const TURN_S = 0.8;
/** Walk this far from the door just come out of and it opens again. */
const EXIT_CLEAR = 4;
/** How rough the floor is: 0 is a perfect mirror, 1 a softly blurred, uneven stone. */
const FLOOR_ROUGHNESS = 1;

/**
 * The street's floor: one plain mirror plane, slightly rough, with no lines
 * on it.
 */
const floorShader = {
  name: 'WorldMeshStreet',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uLight: { value: 0 },
    uBackground: { value: new Color() },
    uHaze: { value: new Color() },
    uRough: { value: FLOOR_ROUGHNESS },
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
    uniform float uLight;
    uniform vec3 uBackground;
    uniform vec3 uHaze;
    uniform float uRough;
    varying vec4 vUv;
    varying vec3 vWorld;

    #include <logdepthbuf_pars_fragment>

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

    // One tap of the reflection, weighted, with the weight in w. A texel that
    // is NaN or infinite (a material on a figure can write one, seen from
    // below at some angles) counts as nothing: left in, it turns the whole
    // floor pixel black, and the blur stamps it out as a cluster of specks.
    // Its exponent bits are tested, as isnan can be compiled away. Filtering
    // next to such a texel can give wild finite values, so a negative tap or
    // one over 64 is dropped too: nothing in this untonemapped scene is lit
    // anywhere near that.
    vec4 reflectionTap(vec4 uv, float weight) {
      vec3 c = texture2DProj(tDiffuse, uv).rgb;
      bool broken = any(equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u)))
        || any(lessThan(c, vec3(0.0))) || any(greaterThan(c, vec3(64.0)));
      return broken ? vec4(0.0) : vec4(c * weight, weight);
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
      vec4 taps = reflectionTap(uv, 0.4)
        + reflectionTap(uv + vec4(spread.x, spread.y * 0.5, 0.0, 0.0), 0.15)
        + reflectionTap(uv + vec4(-spread.x * 0.5, spread.y, 0.0, 0.0), 0.15)
        + reflectionTap(uv + vec4(-spread.x, -spread.y * 0.5, 0.0, 0.0), 0.15)
        + reflectionTap(uv + vec4(spread.x * 0.5, -spread.y, 0.0, 0.0), 0.15);
      // Share out what broken taps would have given among the rest; if all
      // of them are broken, reflect the floor's own colour.
      vec3 reflection = taps.w > 0.0 ? taps.rgb / taps.w : uBackground * uLight;
      // Patchy sheen, plus a fine grain that fades out before it gets smaller than a pixel.
      float patches = valueNoise(ground * 0.45) * 0.6 + valueNoise(ground * 2.1) * 0.4;
      vec2 grainCoord = ground * 26.0;
      float grainVisible = 1.0 - smoothstep(0.35, 0.9, max(fwidth(grainCoord).x, fwidth(grainCoord).y));
      float grain = (valueNoise(grainCoord) - 0.5) * grainVisible;
      float rough = ((patches - 0.5) * 0.9 + grain * 1.2) * uRough;

      float dist = distance(vWorld.xz, cameraPosition.xz);

      // A mirror under a tinted glaze: glossier at grazing angles, faint
      // looking straight down. The rough patches take some of the shine off.
      vec3 toCamera = normalize(cameraPosition - vWorld);
      float glaze = clamp(mix(0.78, 0.96, abs(toCamera.y)) + rough * 0.12, 0.0, 1.0);

      // Dark: black stone. Light: white stone.
      // A faint speckle keeps the black from reading as a flat void.
      vec3 darkFloor = reflection * (1.0 - glaze) + vec3(max(rough, 0.0) * 0.006);
      darkFloor *= 0.5;
      vec3 lightFloor = mix(reflection, uBackground * (1.0 - rough * 0.035), glaze);
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
 * Walk mode: the directory as a place. One street, lined on both sides with
 * buildings standing wall to wall, a building per listed world with its door
 * in the middle of its front. You arrive at the top of the street; walking
 * into a door travels to that world. A door whose world can draw itself
 * live shows it through the doorway, and can be walked straight into.
 * Movement, camera, touch controls and portal triggers all come from the
 * same runtime the worlds themselves use.
 */
export function createLobby(container: HTMLElement, options: LobbyOptions): Lobby {
  const viewOnly = options.doorwayView === true;
  if (viewOnly) silence();
  /** Back through a world's lobby portal: its door, where they came out of it, and the layout it was in then. */
  let cameBack: { url: string; spot: WalkSpot; layout: string } | null = null;
  /** In a world's lobby portal: the door it is seen from (placeViewer), and the layout it was found in. */
  let viewDoor: Door | null = null;
  let viewLayout: string | null = null;
  // Alpha, so a live door's world can show through its doorway (liveDoors).
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const background = new Color();
  const fog = new Fog(0x000000, 25, 100);
  scene.background = background;
  scene.fog = fog;
  let light = options.light ?? false;

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 420);

  const hemisphere = new HemisphereLight(0xffffff, 0x202020, 1.6);
  scene.add(hemisphere);
  const sky = createSky();
  scene.add(sky);
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(4, 10, 6);
  scene.add(sun);
  // The local figure warping in on arrival.
  const arrival = new Arrival();

  const wallMaterial = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.7, metalness: 0 });
  // The storefronts: piers, beams, fascias and panels, a shade off the walls.
  const facadeMaterial = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.7, metalness: 0 });
  // Colliders are never drawn.
  const colliderMaterial = new MeshBasicMaterial({ side: DoubleSide, visible: false });
  const cityMaterials = createCityMaterials();
  const mirror = new Reflector(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
    shader: floorShader,
    ...mirrorResolution(),
  });
  mirror.rotation.x = -Math.PI / 2;
  scene.add(mirror);
  const floorUniforms = (mirror.material as ShaderMaterial).uniforms;
  // Body colour picked in settings.
  let color: string | null = null;

  // Standing on something is required once there are walls to bump into.
  const ground = new Mesh(
    new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    new MeshStandardMaterial({ opacity: 0, transparent: true, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.updateMatrixWorld(true);
  scene.add(ground);

  /** The street, laid out for the worlds there are. */
  let street: StreetPlan = planStreet(options.worlds.length);
  /** The street's buildings (just for looks) and one collider per building. */
  const streetMeshes: Mesh[] = [];
  const streetColliders: Mesh[] = [];

  const known = new Map<string, DoorWorld>();
  const doors = new Map<string, Door>();
  // Worlds drawn live in their doorways, the ones that can be walked straight into (walkThrough).
  const liveDoors = new LiveDoors(renderer.domElement);
  const walkThrough = new WalkThrough({
    live: liveDoors,
    state: () => world.getState(),
    travelUrl: (url) => buildTravelUrl(url),
    viewMode: () => world.getViewMode(),
    color: () => color,
    // Everyone walks as the default character.
    character: () => null,
    characterTicket: () => null,
    cameraDistance: { get: () => world.getCameraDistance(), set: (distance) => world.setCameraDistance(distance) },
    freeze: () => {
      warping = true;
      world.stop();
    },
    entered: (door) => {
      const out = door.inFront(RETURN_STEP * door.group.scale.x);
      returnTo = { position: [out.x, door.group.position.y, out.z], yaw: out.yaw };
      if (door.world) options.onEnterWorld?.(door.world, returnTo);
    },
  });
  const feet = new Vector3();
  const cameraRay = new Raycaster();
  const cameraEye = new Vector3();
  const cameraBack = new Vector3();
  const faceNormal = new Vector3();
  /**
   * A world's doorway is open (walk in and you go through), so it is no
   * collider and the camera's boom would pass it, stopping only at the
   * backstop inside the wall: from there the door's face hides the figure.
   * Pull the camera in to just this side of any door face behind them, as a
   * wall would. Not for the door being walked through, which the camera follows.
   */
  function keepCameraOutOfDoorways(feet: Vector3): void {
    // The boom runs from straight above the feet (the eye) back to the camera.
    cameraBack.set(0, 0, 1).applyQuaternion(camera.quaternion);
    const flat = cameraBack.x * cameraBack.x + cameraBack.z * cameraBack.z;
    if (flat < 1e-4) return;
    const boom = ((camera.position.x - feet.x) * cameraBack.x + (camera.position.z - feet.z) * cameraBack.z) / flat;
    if (boom <= 0.05) return;
    cameraEye.copy(camera.position).addScaledVector(cameraBack, -boom);
    const faces: Mesh[] = [];
    for (const door of doors.values()) if (!door.passable) faces.push(door.face);
    cameraRay.set(cameraEye, cameraBack);
    cameraRay.far = boom + 0.3;
    for (const hit of cameraRay.intersectObjects(faces, false)) {
      // Only from the street side: a face seen from behind is past the wall anyway.
      if (!hit.face || faceNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).dot(cameraBack) > 0) continue;
      // Like the camera rig: 0.3 short of the surface, but never past it, however close they stand.
      const pulled = Math.max(hit.distance - 0.3, hit.distance * 0.5);
      if (pulled < boom) camera.position.copy(cameraEye).addScaledVector(cameraBack, pulled);
      return;
    }
  }

  /** The list the doors were last laid out from, as the order of their URLs. */
  let laidOut = '';
  let time = 0;
  let warping = false;
  /** Lobby clock when this visitor started warping out through a door; negative = not leaving. */
  let leavingAt = -1;
  // The door being walked through.
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

  const spawn = (): Vec3Tuple => [street.spawn.x, 0, street.spawn.z];

  const world = createWorldMesh({
    footsteps: !viewOnly,
    scene,
    camera,
    renderer,
    spawn: spawn(),
    // Held upright, look further down so the street fills the tall screen instead of the sky.
    view: {
      mode: 'third',
      yaw: street.spawn.yaw,
      distance: 5.5,
      pitch: window.innerWidth < window.innerHeight ? -0.32 : -0.15,
      aerial: true,
      aerialMaxHeight: 60,
      aerialDistance: 150,
    },
    vr: true,
    // The lobby is where the way back leads.
    lobbyPortal: false,
    // Minecraft-style flight: double-tap Space.
    abilities: { flying: true },
    ui: { title: 'WorldMesh', badge: false, crosshair: false, deferLockPanel: true, moveBeforeLock: true },
    colliders: () => [
      ground,
      ...(exitDoor ? [exitDoor.face] : []),
      // Every doorway's frame and backstop, so nobody slips past one into the wall.
      ...[...doors.values()].flatMap((door) => door.blockers),
      ...streetColliders,
    ],
    onUpdate: (dt, handle) => {
      time += dt;
      if (viewOnly) placeViewer();
      else if (cameBack && cameBack.layout !== laidOut) followComeBack(handle.getState().position);
      if (emerging) stepEmerging(dt);
      const [x, y, z] = handle.getState().position;
      // Heard from the middle of the street.
      const middle = -street.length / 2;
      options.onListener?.(x, y, z - middle, street.length / 2 + street.halfWidth);
      if (exitDoor && !emerging) {
        const { x: doorX, z: doorZ } = exitDoor.inFront(0);
        if (Math.hypot(x - doorX, z - doorZ) > EXIT_CLEAR) setExitDoor(null);
      }
      for (const door of doors.values()) {
        door.update(time);
        if (Math.abs(y - door.group.position.y) > 1) continue;
        if (!warping && !emerging && !viewOnly && door.contains(x, z)) enter(door);
      }
      walkThrough.update();
      if (world.getViewMode() === 'third' && !renderer.xr.isPresenting) keepCameraOutOfDoorways(feet.set(x, y, z));
      // The sky is centred on the camera, so it stays around it however high they fly.
      sky.position.copy(camera.position);
      updateSky(sky, time);
      let appear = arrival.update(dt);
      // Leaving: the arrival's warp in reverse, from solid back to nothing.
      if (leavingAt >= 0) appear = 1 - Math.min(1, (time - leavingAt) / LEAVE_TIME);
      if (leavingAt >= 0) updateLens(time - leavingAt);
      // Into a portal, the figure smears through it, not up and down.
      if (appear !== null) setLocalAppear(world.avatar, appear, leavingAt >= 0 && warpDoor ? warpDoor.through(new Vector3()) : undefined);
      // Keep the finite floor under the player. Its roughness is drawn in
      // world space, so moving the plane does not move it.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      // Last, with the camera where it will be drawn from: the worlds seen live through their doors.
      walkThrough.step(camera, feet.set(x, y, z));
      // Never another world's live view inside a world's lobby portal.
      liveDoors.update(doors.values(), camera, feet, !renderer.xr.isPresenting && !viewOnly);
    },
  });
  // The page's own buttons stand aside in the bird's-eye view, like the runtime's.
  world.on('view:change', ({ mode }) => document.documentElement.classList.toggle('birds-eye', mode === 'aerial'));

  // Warp in as soon as the world is running, before the street finishes building.
  // Back through a world's lobby portal, its door is looked up once the doors are up.
  if (!options.start && !options.from && !viewOnly) triggerSpawnFx();

  /** Walking through a door: flash, then travel to the world's own URL. */
  function enter(door: Door): void {
    // A door whose live world can be walked into: walk on through instead.
    if (walkThrough.enter(door)) return;
    const target = door.world;
    if (!target) return;
    door.surge();
    door.warp();
    const out = door.inFront(RETURN_STEP * door.group.scale.x);
    travel(target, { position: [out.x, door.group.position.y, out.z], yaw: out.yaw }, door);
  }

  /**
   * Going through: the lens pulls wide, faster and faster, so the view
   * stretches out like a fisheye into the flash.
   */
  function updateLens(since: number): void {
    const t = Math.min(1, since / (WARP_MS / 1000));
    camera.fov = baseFov + LENS_FOV * t * t;
    camera.updateProjectionMatrix();
    renderer.domElement.classList.add('lensing');
  }

  /** Coming out: the going-in lens in reverse, from wide back to normal as the flash clears. */
  function updateLensOut(since: number): void {
    const t = Math.min(1, Math.max(0, (since - FLASH_HOLD_S) / LENS_OUT_S));
    camera.fov = baseFov + LENS_FOV * (1 - t) * (1 - t);
    camera.updateProjectionMatrix();
    if (t > 0) renderer.domElement.classList.remove('lensing');
  }

  /** Into a world: flash, then go to its own URL. `spot` is where to come back out. */
  function travel(target: DoorWorld, spot: WalkSpot, door: Door): void {
    if (warping) return;
    warping = true;
    leavingAt = time;
    playWarpSound(false);
    warpDoor = door;
    returnTo = spot;
    options.onEnterWorld?.(target, returnTo);
    world.releasePointer();
    flash.classList.add('active');
    const url = buildTravelUrl(target.url);
    warpTimer = window.setTimeout(() => {
      window.location.href = url;
    }, WARP_MS);
  }

  // Fell off the edge of the world: back to the top of the street.
  world.on('respawn', () => {
    world.teleport(spawn(), street.spawn.yaw);
    aimSpawn();
  });

  // Coming back with the browser's back button can restore this page as it
  // was left: mid-warp and standing in a doorway. Step the visitor back out.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || viewOnly) return;
    window.clearTimeout(warpTimer);
    warpDoor?.settle();
    warpDoor = null;
    warping = false;
    if (leavingAt >= 0) {
      leavingAt = -1;
      setLocalAppear(world.avatar, 1);
    }
    flash.classList.remove('active');
    // Back from the world (the page kept from before): the lens as it was.
    renderer.domElement.classList.remove('lensing');
    handleResize();
    if (returnTo) emerge(returnTo);
    else {
      world.teleport(spawn(), street.spawn.yaw);
      triggerSpawnFx();
    }
  };
  window.addEventListener('pageshow', handlePageShow);

  let baseFov = 70;
  const handleResize = () => {
    const { textureWidth, textureHeight } = mirrorResolution();
    mirror.getRenderTarget().setSize(textureWidth, textureHeight);
    // A phone held upright sees a narrow slice of the world; widen the lens so
    // the doors either side stay in view.
    const aspect = window.innerWidth / window.innerHeight;
    baseFov = aspect < 1 ? 70 + (1 - aspect) * 30 : 70;
    camera.fov = baseFov;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', handleResize);
  handleResize();

  applyTheme();
  setWorlds(options.worlds);
  if (options.color) setColor(options.color);
  // Stored coordinates rather than a door to look up: community worlds arrive
  // a moment later and shift every door, and these already match the full list.
  if (options.start) emerge(options.start);
  else if (options.from && !viewOnly) {
    // Back through a world's lobby portal: out of its door, in the same light the warp left in.
    if (comeBackFrom(options.from)) flash.classList.add('active');
    else triggerSpawnFx();
  }

  if (import.meta.env.DEV) Object.assign(window, { lobby: world, spawnFx: () => triggerSpawnFx() });

  return { setWorlds, refreshEntries, setTheme, setColor, dispose };

  /** The local figure warping in at the top of the street. */
  function triggerSpawnFx(): void {
    arrival.start(() => world.avatar);
    // In time with the warp, which waits a moment before it starts.
    playWarpSound(true, 0.2);
    setLocalAppear(world.avatar, 0);
    aimSpawn();
  }

  /** Look down the street, the body facing the same way, its back to the camera. */
  function aimSpawn(): void {
    const yaw = street.spawn.yaw;
    world.setState({ yaw, facing: yaw });
  }

  /** The door of the world at `url` (address and path; any query or fragment aside), or null if it has none here. */
  function doorOf(url: string): Door | null {
    const place = (address: string) => canonicalUrl(address).replace(/[?#].*$/, '');
    const key = place(url);
    for (const door of doors.values()) if (door.world && place(door.world.url) === key) return door;
    return null;
  }

  /**
   * Back through the lobby portal of the world at `url`: come out of its
   * door. False if it has none here.
   */
  function comeBackFrom(url: string): boolean {
    const door = doorOf(url);
    if (!door) return false;
    const out = door.inFront(RETURN_STEP * door.group.scale.x);
    const spot: WalkSpot = { position: [out.x, door.group.position.y, out.z], yaw: out.yaw };
    const moved = !cameBack || Math.hypot(cameBack.spot.position[0] - out.x, cameBack.spot.position[2] - out.z) > 0.5;
    cameBack = { url, spot, layout: laidOut };
    if (moved) emerge(spot);
    return true;
  }

  /**
   * The doors were laid out again (the full list arrives after the lobby is
   * up). Not walked off yet: out of the door where it is now. Otherwise they
   * are left where they are.
   */
  function followComeBack([x, , z]: Vec3Tuple): void {
    const { url, spot } = cameBack!;
    const waiting = emerging || Math.hypot(x - spot.position[0], z - spot.position[2]) < 0.5;
    if (!waiting || !comeBackFrom(url)) cameBack = null;
  }

  /**
   * In a world's lobby portal: stand just in front of that world's door,
   * facing into the street, so the portal opens where the door does (and
   * follow it as the doors are laid out again); without one, at the top of
   * the street. The door's own face is taken down: the view is clipped at
   * the doorway, but not the face's shader, which would cover everything.
   */
  function placeViewer(): void {
    if (viewLayout !== laidOut) {
      viewLayout = laidOut;
      const door = options.from ? doorOf(options.from) : null;
      if (viewDoor) viewDoor.face.visible = true;
      if (door) door.face.visible = false;
      viewDoor = door;
    }
    const door = viewDoor;
    const out = door?.inFront(VIEW_STEP);
    const position: Vec3Tuple = out && door ? [out.x, door.group.position.y, out.z] : spawn();
    const yaw = out ? out.yaw : street.spawn.yaw;
    const [x, , z] = world.getState().position;
    if (Math.hypot(position[0] - x, position[2] - z) < 0.01 && angleDelta(world.getState().yaw, yaw) < 0.001) return;
    world.teleport(position, yaw);
  }

  /** Come back out of the door behind `spot`, walking a few steps into the street. */
  function emerge(spot: WalkSpot): void {
    const [x, , z] = spot.position;
    // Light up the door they come out of, if it is there yet: community
    // worlds may still be loading.
    const door = [...doors.values()].find((candidate) => {
      const out = candidate.inFront(RETURN_STEP);
      return Math.hypot(out.x - x, out.z - z) < 0.5;
    }) ?? null;
    door?.surge();
    // Out through the same warp as going in: rings on the door, and the lens easing back from wide.
    door?.warp();
    // Blurred straight away (no fade in), then clearing as the lens settles.
    const canvas = renderer.domElement;
    canvas.style.transition = 'none';
    canvas.classList.add('lensing');
    void canvas.offsetWidth;
    canvas.style.transition = '';
    updateLensOut(0);
    // Open until they are out: it would stop them walking through it.
    if (exitDoor) setExitDoor(null);
    emerging = { spot, door, time: 0, orbit: world.getViewMode() === 'third' };
    stepEmerging(0);
  }

  function stepEmerging(dt: number): void {
    const { spot, door, orbit } = emerging!;
    const t = (emerging!.time += dt);
    if (t >= FLASH_HOLD_S) flash.classList.remove('active');
    updateLensOut(t);

    // Ease out: a walk that slows to a stop at the spot.
    const walk = Math.min(t / WALK_OUT_S, 1);
    // Out in front of it now: shut it behind them before the camera comes round.
    if (walk === 1 && door && exitDoor !== door) setExitDoor(door);
    const length = RETURN_STEP - WALK_OUT_FROM;
    const along = WALK_OUT_FROM + length * Math.sin((walk * Math.PI) / 2) - RETURN_STEP;
    const speed = walk < 1 ? ((length * Math.PI) / 2 / WALK_OUT_S) * Math.cos((walk * Math.PI) / 2) : 0;
    // Looking along spot.yaw faces out of the door, into the street.
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

  function setColor(next: string): void {
    color = next;
    if (world.avatar) setAvatarColor(world.avatar, next);
  }

  function setTheme(isLight: boolean): void {
    if (isLight === light) return;
    light = isLight;
    applyTheme();
    for (const door of doors.values()) door.setTheme(light);
  }

  function applyTheme(): void {
    // Light: a blue sky over pale buildings. Dark: a faint grey horizon deepening to black
    // overhead. The fog matches the horizon and swallows the far end of a long street.
    background.set(skyHorizon(light));
    renderer.setClearColor(background);
    applySkyTheme(sky, light);
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
    facadeMaterial.color.set(light ? 0xdde1ea : 0x1f2026);
    facadeMaterial.emissive.set(light ? 0x4f5460 : 0x000000);
    applyCityTheme(cityMaterials, light);
  }

  function refreshEntries(): void {
    for (const [url, door] of doors) door.setEntries(options.entries?.(url));
  }

  /**
   * A building for every world, in list order down the street: the first on
   * the left, the second across from it, and so on.
   */
  function setWorlds(worlds: LobbyWorld[]): void {
    const urls: string[] = [];
    for (const entry of worlds) {
      if (urls.includes(entry.url)) continue;
      known.set(entry.url, entry);
      urls.push(entry.url);
    }
    const key = JSON.stringify(urls);
    if (key === laidOut) return;
    laidOut = key;
    street = planStreet(urls.length);
    urls.forEach((url, i) => {
      let door = doors.get(url);
      if (!door) {
        door = new Door(known.get(url)!, light);
        door.setEntries(options.entries?.(url));
        scene.add(door.group);
        doors.set(url, door);
      }
      const slot = street.slots[i];
      door.place(slot.x, slot.z, slot.x + slot.facingX, slot.z + slot.facingZ);
    });
    // Worlds that are no longer listed take their doors down.
    for (const [url, door] of doors) {
      if (urls.includes(url)) continue;
      if (door === exitDoor) exitDoor = null;
      door.dispose();
      doors.delete(url);
    }
    buildStreet(urls);
    world.refreshColliders();
  }

  /**
   * The street's buildings, dressed as storefronts round the worlds' doors.
   * One mesh each for the walls, the storefronts' trim and the light; each
   * door carries its own sign.
   */
  function buildStreet(urls: string[]): void {
    for (const mesh of [...streetMeshes, ...streetColliders]) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    streetMeshes.length = 0;
    streetColliders.length = 0;
    const blocks = buildAvenues(street, urls.length);
    // Each storefront's sign hangs from its door, so it comes and goes with the world.
    urls.forEach((url, i) => {
      const sign = blocks.signs[i];
      doors.get(url)?.setSign(sign?.geometry ?? null, sign?.aspect);
    });
    for (const [geometries, material] of [[blocks.solid, wallMaterial], [blocks.trim, facadeMaterial], [blocks.glow, cityMaterials.glow]] as const) {
      const mesh = new Mesh(mergeGeometries(geometries as BufferGeometry[]), material);
      for (const geometry of geometries) geometry.dispose();
      scene.add(mesh);
      streetMeshes.push(mesh);
    }
    // Colliders need world matrices, but are never drawn: keep them out of the scene.
    for (const geometry of blocks.colliders) {
      const collider = new Mesh(geometry, colliderMaterial);
      collider.updateMatrixWorld(true);
      streetColliders.push(collider);
    }
  }

  function dispose(): void {
    walkThrough.dispose();
    liveDoors.dispose();
    window.clearTimeout(warpTimer);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('resize', handleResize);
    world.dispose();
    for (const door of doors.values()) door.dispose();
    doors.clear();
    document.documentElement.classList.remove('birds-eye');
    for (const mesh of [...streetMeshes, ...streetColliders]) mesh.geometry.dispose();
    wallMaterial.dispose();
    facadeMaterial.dispose();
    colliderMaterial.dispose();
    cityMaterials.dispose();
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

function angleDelta(a: number, b: number): number {
  const turn = Math.PI * 2;
  const d = (((a - b) % turn) + turn) % turn;
  return Math.min(d, turn - d);
}

/** Fill the local figure in from scattered points. */
function setLocalAppear(root: Object3D | null, amount: number, axis?: Vector3): void {
  if (!root) return;
  setStrokeOpacity(root, amount);
  if (setAvatarAppear(root, amount, axis)) return;
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

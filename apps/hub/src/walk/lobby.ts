import { buildTravelUrl, createWorldMesh } from '@worldmesh/runtime';
import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { Presence } from './presence';
import { DOOR_HALF_SPAN, DOOR_TOP, Door, type DoorWorld } from './door';

export interface LobbyOptions {
  worlds: DoorWorld[];
  /** Draw the lobby white with dark lines instead of black with light ones. */
  light?: boolean;
  /** WebSocket base URL of the presence server. Leave empty for single-player. */
  presenceEndpoint?: string;
  /** Called with how many people are in the lobby, or null while offline. */
  onPresenceCount?: (count: number | null) => void;
  /** Called right before the page navigates into a world. */
  onEnterWorld?: (world: DoorWorld) => void;
}

export interface Lobby {
  /** Add doors for worlds that were not listed yet. */
  setWorlds(worlds: DoorWorld[]): void;
  /**
   * Switch between the dark and light lobby. Purely local: other visitors
   * keep whatever their own device prefers.
   */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** Objects on this layer are drawn by the main camera but not seen in the floor mirror. */
const FLOOR_LAYER = 1;
const FLOOR_SIZE = 600;
/** The round wall: never smaller than this, and grows so doors keep this much wall between them. */
const WALL_MIN_RADIUS = 11;
const DOOR_SPACING = 4.2;
const WALL_HEIGHT = 5.2;
const WARP_MS = 450;

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

      gl_FragColor = vec4(mix(darkFloor, lightFloor, uLight), 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/**
 * Walk mode: the directory as a place. Every listed world is a door on an
 * endless black grid, and walking into one travels to that world. Movement,
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

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 320);
  camera.layers.enable(FLOOR_LAYER);

  scene.add(new HemisphereLight(0xffffff, 0x202020, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const wallMaterial = new MeshStandardMaterial({ side: DoubleSide, roughness: 0.85, metalness: 0 });
  const mirror = new Reflector(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
    shader: floorShader,
    ...mirrorResolution(),
  });
  mirror.rotation.x = -Math.PI / 2;
  scene.add(mirror);
  const floorUniforms = (mirror.material as ShaderMaterial).uniforms;
  applyTheme();

  const presence = options.presenceEndpoint
    ? new Presence(options.presenceEndpoint, 'lobby', scene, (count) => options.onPresenceCount?.(count))
    : undefined;

  // The wall the doors are set into. Rebuilt whenever the door count changes.
  const wall: Mesh[] = [];
  // Standing on something is required once there are walls to bump into.
  const ground = new Mesh(new CircleGeometry(1, 48));
  ground.rotation.x = -Math.PI / 2;
  ground.visible = false;
  scene.add(ground);

  const known = new Map<string, DoorWorld>();
  const doors = new Map<string, Door>();
  let time = 0;
  let warping: Door | null = null;
  let warpTimer = 0;

  const flash = document.createElement('div');
  flash.className = 'walk-flash';
  container.appendChild(flash);

  const world = createWorldMesh({
    scene,
    camera,
    renderer,
    spawn: [0, 0, 0],
    // Held upright, look further down so the floor fills the tall screen instead of the sky.
    view: { mode: 'third', distance: 5.5, pitch: window.innerWidth < window.innerHeight ? -0.32 : -0.15 },
    ui: { title: 'WorldMesh', badge: false, crosshair: false },
    network: presence,
    colliders: () => [ground, ...wall],
    onUpdate: (dt, handle) => {
      time += dt;
      const [x, , z] = handle.getState().position;
      for (const door of doors.values()) {
        door.update(time);
        if (!warping && door.contains(x, z)) enter(door);
      }
      floorUniforms.uPlayer.value.set(x, z);
      // Keep the finite floor under the player. The grid is drawn in world
      // space, so moving the plane does not move the lines.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      presence?.update(dt);
    },
  });

  /** Walking through a door: flash, then travel to the world's own URL. */
  function enter(door: Door): void {
    warping = door;
    door.surge();
    options.onEnterWorld?.(door.world);
    document.exitPointerLock?.();
    flash.classList.add('active');
    const url = buildTravelUrl(door.world.url);
    warpTimer = window.setTimeout(() => {
      window.location.href = url;
    }, WARP_MS);
  }

  // Coming back with the browser's back button can restore this page as it
  // was left: mid-warp and standing in a doorway. Put the visitor back.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    window.clearTimeout(warpTimer);
    warping?.settle();
    warping = null;
    flash.classList.remove('active');
    world.respawn();
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

  if (import.meta.env.DEV) Object.assign(window, { lobby: world });

  return { setWorlds, setTheme, dispose };

  function setTheme(isLight: boolean): void {
    if (isLight === light) return;
    light = isLight;
    applyTheme();
    for (const door of doors.values()) door.setTheme(light);
  }

  function applyTheme(): void {
    background.set(light ? 0xf2f2f2 : 0x000000);
    renderer.setClearColor(background);
    fog.color.copy(background);
    floorUniforms.uBackground.value.copy(background);
    floorUniforms.uLight.value = light ? 1 : 0;
    wallMaterial.color.set(light ? 0xe4e4e4 : 0x0e0e0e);
  }

  function setWorlds(worlds: DoorWorld[]): void {
    for (const entry of worlds) {
      if (!known.has(entry.url)) known.set(entry.url, entry);
    }

    // Everyone with the same list gets the same ring, so visitors who see
    // each other also see the same doors around them.
    const urls = [...known.keys()].sort();
    const radius = Math.max(WALL_MIN_RADIUS, (urls.length * DOOR_SPACING) / (Math.PI * 2));
    const angles = urls.map((_, i) => Math.PI + (i / Math.max(urls.length, 1)) * Math.PI * 2);
    urls.forEach((url, i) => {
      let door = doors.get(url);
      if (!door) {
        door = new Door(known.get(url)!, light);
        scene.add(door.group);
        doors.set(url, door);
      }
      // Set into the wall, facing the middle of the room.
      door.place(Math.sin(angles[i]) * radius, Math.cos(angles[i]) * radius, 0, 0);
    });
    buildWall(radius, angles);
  }

  /** Curved wall sections between the doors, leaving a gap for each doorway. */
  function buildWall(radius: number, angles: number[]): void {
    for (const section of wall) {
      section.geometry.dispose();
      section.removeFromParent();
    }
    wall.length = 0;
    ground.scale.setScalar(radius + 4);

    const gap = DOOR_HALF_SPAN / radius;
    const spans: [number, number][] = angles.length
      ? angles.map((a, i) => {
          const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
          return [a + gap, next - a - gap * 2];
        })
      : [[0, Math.PI * 2]];
    const add = (start: number, length: number, bottom: number) => {
      if (length <= 0) return;
      const height = WALL_HEIGHT - bottom;
      const segments = Math.max(2, Math.ceil(length * 24));
      const section = new Mesh(facingInward(new CylinderGeometry(radius, radius, height, segments, 1, true, start, length)), wallMaterial);
      section.position.y = bottom + height / 2;
      scene.add(section);
      wall.push(section);
    };
    for (const [start, length] of spans) add(start, length, 0);
    // Close the wall over each doorway.
    for (const a of angles) add(a - gap, gap * 2, DOOR_TOP);
    world.refreshColliders();
  }

  function dispose(): void {
    window.clearTimeout(warpTimer);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('resize', handleResize);
    world.dispose();
    for (const door of doors.values()) door.dispose();
    doors.clear();
    for (const section of wall) section.geometry.dispose();
    wallMaterial.dispose();
    ground.geometry.dispose();
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

/**
 * Turn a cylinder inside out, so its faces point at the middle of the room.
 * The runtime only blocks movement into the front of a face, and the wall has
 * to stop people walking out, not in.
 */
function facingInward(geometry: CylinderGeometry): CylinderGeometry {
  const index = geometry.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}

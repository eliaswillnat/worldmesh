import { createWorldMesh } from '@worldmesh/runtime';
import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { AVATAR_HEIGHT, AVATAR_RADIUS, createAvatar } from './avatar';
import { Presence } from './presence';
import { WORMHOLE_TRIGGER, Wormhole, type WormholeWorld } from './wormhole';

export interface LobbyOptions {
  worlds: WormholeWorld[];
  /** WebSocket base URL of the presence server. Leave empty for single-player. */
  presenceEndpoint?: string;
  /** Called with how many people are in the lobby, or null while offline. */
  onPresenceCount?: (count: number | null) => void;
  /** Called right before the page navigates into a world. */
  onEnterWorld?: (world: WormholeWorld) => void;
}

export interface Lobby {
  /** Add wormholes for worlds that were not listed yet. */
  setWorlds(worlds: WormholeWorld[]): void;
  dispose(): void;
}

/** Objects on this layer are drawn by the main camera but not seen in the floor mirror. */
const FLOOR_LAYER = 1;
const FLOOR_SIZE = 600;
const SPAWN_CLEARANCE = 7;
const MIN_GAP = 7;
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
      float fade = 1.0 - smoothstep(18.0, 110.0, distance(vWorld.xz, cameraPosition.xz));
      // Lines light up a little around the player.
      float glow = 1.0 - smoothstep(0.0, 14.0, distance(vWorld.xz, uPlayer));
      float lines = max(minor * 0.09, major * 0.24) * fade * (1.0 + glow * 1.6);

      // A dark mirror: glossier at grazing angles, dim looking straight down.
      vec3 toCamera = normalize(cameraPosition - vWorld);
      float dim = mix(0.5, 0.86, abs(toCamera.y));

      gl_FragColor = vec4(reflection * (1.0 - dim) * (1.0 - lines) + vec3(lines), 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/**
 * Walk mode: the directory as a place. Every listed world is a wormhole on an
 * endless black grid, and walking into one travels to that world. Movement,
 * camera, touch controls and portal triggers all come from the same runtime
 * the worlds themselves use.
 */
export function createLobby(container: HTMLElement, options: LobbyOptions): Lobby {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setClearColor(0x000000);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x000000);
  scene.fog = new Fog(0x000000, 30, 120);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 320);
  camera.layers.enable(FLOOR_LAYER);

  scene.add(new HemisphereLight(0xffffff, 0x202020, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const mirror = new Reflector(new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
    shader: floorShader,
    ...mirrorResolution(),
  });
  mirror.rotation.x = -Math.PI / 2;
  scene.add(mirror);
  const floorUniforms = (mirror.material as ShaderMaterial).uniforms;

  const presence = options.presenceEndpoint
    ? new Presence(options.presenceEndpoint, 'lobby', scene, (count) => options.onPresenceCount?.(count))
    : undefined;

  const wormholes = new Map<string, Wormhole>();
  let time = 0;
  let warping: Wormhole | null = null;
  let warpTimer = 0;

  const flash = document.createElement('div');
  flash.className = 'walk-flash';
  container.appendChild(flash);

  const world = createWorldMesh({
    scene,
    camera,
    renderer,
    spawn: [0, 0, 0],
    player: { height: AVATAR_HEIGHT, radius: AVATAR_RADIUS, avatar: createAvatar() },
    view: { mode: 'third', distance: 5.5, pitch: -0.15 },
    ui: { title: 'WorldMesh', badge: false },
    network: presence,
    onUpdate: (dt, handle) => {
      time += dt;
      const [x, , z] = handle.getState().position;
      const player = new Vector3(x, 0, z);
      for (const wormhole of wormholes.values()) {
        if (wormhole !== warping) wormhole.update(time, player);
      }
      floorUniforms.uPlayer.value.set(x, z);
      // Keep the finite floor under the player. The grid is drawn in world
      // space, so moving the plane does not move the lines.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      presence?.update(dt);
    },
  });

  world.on('portal:activate', (event) => {
    event.preventDefault();
    if (warping) return;
    const wormhole = wormholes.get(event.portal.url);
    if (!wormhole) return;

    warping = wormhole;
    wormhole.surge();
    options.onEnterWorld?.(wormhole.world);
    document.exitPointerLock?.();
    flash.classList.add('active');
    warpTimer = window.setTimeout(() => {
      window.location.href = event.url;
    }, WARP_MS);
  });

  // Coming back with the browser's back button can restore this page as it
  // was left: mid-warp and standing in a wormhole. Put the visitor back.
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
  };
  window.addEventListener('resize', handleResize);

  setWorlds(options.worlds);

  if (import.meta.env.DEV) Object.assign(window, { lobby: world });

  return { setWorlds, dispose };

  function setWorlds(worlds: WormholeWorld[]): void {
    const taken = [...wormholes.values()].map((w) => new Vector2(w.group.position.x, w.group.position.z));
    const fresh = worlds.filter((w) => !wormholes.has(w.url));
    let reach = Math.max(16, Math.sqrt(taken.length + fresh.length) * 7);

    for (const entry of fresh) {
      let spot: Vector2 | null = null;
      while (!spot) {
        for (let attempt = 0; attempt < 60 && !spot; attempt++) {
          const angle = Math.random() * Math.PI * 2;
          const distance = SPAWN_CLEARANCE + Math.sqrt(Math.random()) * (reach - SPAWN_CLEARANCE);
          const candidate = new Vector2(Math.sin(angle) * distance, -Math.cos(angle) * distance);
          if (taken.every((other) => other.distanceTo(candidate) >= MIN_GAP)) spot = candidate;
        }
        reach += 3;
      }
      taken.push(spot);

      const wormhole = new Wormhole(entry, new Vector3(spot.x, 0, spot.y), FLOOR_LAYER);
      scene.add(wormhole.group);
      wormholes.set(entry.url, wormhole);
      world.addPortal({
        url: entry.url,
        label: entry.name,
        position: [spot.x, 0, spot.y],
        radius: WORMHOLE_TRIGGER,
        mode: 'auto',
        visual: false,
      });
    }
  }

  function dispose(): void {
    window.clearTimeout(warpTimer);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('resize', handleResize);
    world.dispose();
    for (const wormhole of wormholes.values()) wormhole.dispose();
    wormholes.clear();
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
  const scale = Math.min(window.devicePixelRatio, 2) * 0.5;
  return {
    textureWidth: Math.max(256, Math.round(window.innerWidth * scale)),
    textureHeight: Math.max(256, Math.round(window.innerHeight * scale)),
  };
}

import { buildTravelUrl, createWorldMesh } from '@worldmesh/runtime';
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Matrix4,
  Mesh,
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
} from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY_GLOW_WHITE, SKY_HORIZON, applyCityTheme, createCity, createCityMaterials, createSky, flipInside, type City } from './city';
import { Presence } from './presence';
import { DOOR_HALF_SPAN, DOOR_TOP, Door, type DoorWorld } from './door';

export interface LobbyOptions {
  worlds: DoorWorld[];
  /** Draw the lobby white with dark lines instead of black with light ones. */
  light?: boolean;
  /** WebSocket base URL of the presence server. Leave empty for single-player. */
  presenceEndpoint?: string;
  /** Name shown above this visitor for everyone else; null shows them as a guest. */
  playerName?: () => string | null;
  /** Called with how many people are in the lobby, or null while offline. */
  onPresenceCount?: (count: number | null) => void;
  /** Called right before the page navigates into a world. */
  onEnterWorld?: (world: DoorWorld) => void;
  /** Called when someone picks an empty door to add their own world. */
  onAddWorld?: () => void;
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
const TAP_RANGE = 40;
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

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 320);
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
  let city: City | null = null;
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
  applyTheme();

  const presence = options.presenceEndpoint
    ? new Presence(
        options.presenceEndpoint,
        'lobby',
        scene,
        (count) => options.onPresenceCount?.(count),
        options.playerName,
      )
    : undefined;

  // The citadel's walls (solid) and trim (just for looks). Rebuilt whenever
  // the door count changes.
  const wall: Mesh[] = [];
  const trim: Mesh[] = [];
  // Standing on something is required once there are walls to bump into.
  const ground = new Mesh(new CircleGeometry(1, 48));
  ground.rotation.x = -Math.PI / 2;
  ground.visible = false;
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
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  let time = 0;
  let warping: Door | null = null;
  let warpTimer = 0;

  const flash = document.createElement('div');
  flash.className = 'walk-flash';
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

  const world = createWorldMesh({
    scene,
    camera,
    renderer,
    spawn: [0, 0, 0],
    // Held upright, look further down so the floor fills the tall screen instead of the sky.
    view: { mode: 'third', distance: 5.5, pitch: window.innerWidth < window.innerHeight ? -0.32 : -0.15 },
    ui: { title: 'WorldMesh', badge: false, crosshair: false },
    network: presence,
    // Empty doors are closed: their faces stop you like the wall does.
    colliders: () => [ground, ...wall, ...emptyDoors.map((door) => door.face), ...(city?.colliders ?? [])],
    onUpdate: (dt, handle) => {
      time += dt;
      const [x, , z] = handle.getState().position;
      for (const door of [...doors.values(), randomDoor]) {
        door.update(time);
        if (!warping && door.contains(x, z)) enter(door);
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
      floorUniforms.uPlayer.value.set(x, z);
      sky.position.set(x, 0, z);
      // Keep the finite floor under the player. The grid is drawn in world
      // space, so moving the plane does not move the lines.
      mirror.position.set(Math.round(x / 10) * 10, 0, Math.round(z / 10) * 10);
      presence?.update(dt);
    },
  });

  /** Walking through a door: flash, then travel to the world's own URL. */
  function enter(door: Door): void {
    const target = door.random ? pickRandomWorld() : door.world;
    if (!target) return;
    warping = door;
    door.surge();
    options.onEnterWorld?.(target);
    document.exitPointerLock?.();
    flash.classList.add('active');
    const url = buildTravelUrl(target.url);
    warpTimer = window.setTimeout(() => {
      window.location.href = url;
    }, WARP_MS);
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

  // Keyboard: E next to an empty door. The runtime reports E as a plain
  // interaction when no portal of its own is in reach.
  world.on('interact', () => {
    if (nearEmpty) addWorld();
  });

  // Pointer: clicking or tapping an empty door on screen picks it. While the
  // mouse is captured there is no cursor, so a click aims where the camera
  // looks, or picks the door you are standing at.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pressAt: { x: number; y: number; time: number } | null = null;
  const emptyDoorAt = (ndcX: number, ndcY: number): Door | null => {
    raycaster.setFromCamera(pointer.set(ndcX, ndcY), camera);
    raycaster.far = TAP_RANGE;
    const hit = raycaster.intersectObjects([...wall, ...emptyDoors.map((door) => door.face)], false)[0];
    return emptyDoors.find((door) => door.face === hit?.object) ?? null;
  };
  const handlePointerDown = (event: PointerEvent) => {
    pressAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    if (document.pointerLockElement === renderer.domElement && (nearEmpty || emptyDoorAt(0, 0))) addWorld();
  };
  const handlePointerUp = (event: PointerEvent) => {
    const press = pressAt;
    pressAt = null;
    if (!press || document.pointerLockElement === renderer.domElement) return;
    // A tap, not a drag to look around.
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 10 || performance.now() - press.time > 400) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    if (emptyDoorAt(ndcX, ndcY)) addWorld();
  };
  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointerup', handlePointerUp);

  // Coming back with the browser's back button can restore this page as it
  // was left: mid-warp and standing in a doorway. Put the visitor back.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    window.clearTimeout(warpTimer);
    warping?.settle();
    warping = null;
    adding = false;
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
    for (const door of [...doors.values(), ...emptyDoors, randomDoor]) door.setTheme(light);
  }

  function applyTheme(): void {
    // Light: a plain blue sky over white towers. Dark: black, lit by the screens.
    background.set(light ? SKY_HORIZON : 0x000000);
    renderer.setClearColor(background);
    sky.visible = light;
    fog.color.copy(background);
    fog.near = light ? 60 : 35;
    fog.far = light ? 240 : 170;
    hemisphere.groundColor.set(light ? 0xdde5f2 : 0x202020);
    hemisphere.intensity = light ? 2 : 1.6;
    floorUniforms.uBackground.value.set(light ? 0xf1f4fa : 0x000000);
    floorUniforms.uHaze.value.copy(background);
    floorUniforms.uLight.value = light ? 1 : 0;
    wallMaterial.color.set(light ? 0xf5f6fa : 0x141418);
    // Lift the shaded sides so white stays white, not grey.
    wallMaterial.emissive.set(light ? CITY_GLOW_WHITE : 0x000000);
    applyCityTheme(cityMaterials, light);
  }

  function setWorlds(worlds: DoorWorld[]): void {
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

  /** The city only depends on how wide the citadel is. */
  function buildCity(outer: number): void {
    if (city && city.group.userData.outer === outer) return;
    city?.dispose();
    city = createCity(outer, cityMaterials);
    city.group.userData.outer = outer;
    scene.add(city.group);
    ground.scale.setScalar(city.radius + 2);
    randomDoor.place(city.entrance.x, city.entrance.z, 0, 0);
  }

  function dispose(): void {
    disposed = true;
    window.clearTimeout(warpTimer);
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
    city?.dispose();
    cityMaterials.dispose();
    sky.geometry.dispose();
    sky.material.dispose();
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

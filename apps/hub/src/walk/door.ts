import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  MeshBasicMaterial,
  Texture,
  TextureLoader,
  Vector2,
  type Material,
} from 'three';
import { drawEntries, measureEntries } from '../entries';
import { createGodRayMaterial } from './city';

export interface DoorWorld {
  name: string;
  url: string;
  cover?: string;
  color?: string;
  creator?: string;
  /** Listing tags; the ones in DOOR_FEATURES show as chips under the name. */
  tags?: string[];
}

/** Tags worth calling out above a door, in the order they are shown. */
export const DOOR_FEATURES: ReadonlyArray<{ tags: readonly string[]; label: string }> = [
  { tags: ['multiplayer', 'mmo', 'coop', 'co-op'], label: 'Multiplayer' },
  { tags: ['vr', 'webxr', 'xr'], label: 'VR supported' },
  { tags: ['ar'], label: 'AR supported' },
  { tags: ['gamepad', 'controller'], label: 'Gamepad' },
  { tags: ['voice', 'voice-chat'], label: 'Voice chat' },
  { tags: ['desktop-only', 'desktop'], label: 'Desktop only' },
];
/** More chips than this would crowd the wall between doors. */
const MAX_FEATURES = 3;

/** The feature chips a world's tags earn, at most MAX_FEATURES. */
export function doorFeatures(tags: readonly string[] | undefined): string[] {
  const own = new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()));
  return DOOR_FEATURES.filter((feature) => feature.tags.some((tag) => own.has(tag)))
    .map((feature) => feature.label)
    .slice(0, MAX_FEATURES);
}

/** Size of the doorway opening, in metres: 3:4 portrait, like the covers. */
export const DOOR_WIDTH = 4.2;
export const DOOR_HEIGHT = 5.6;
/** Frame thickness and depth. */
export const FRAME = 0.16;
const DEPTH = 0.32;
/** Step this close to the doorway to go through. */
const THRESHOLD = 0.1;
/**
 * How far behind the doorway still counts as inside it. Less than the wall is
 * thick, so walking past the outside of the wall never goes through.
 */
const REACH = 1;
/** Half the width a door takes up along a wall, frame included. */
export const DOOR_HALF_SPAN = DOOR_WIDTH / 2 + FRAME;
/** Top of the frame, where the wall closes over the doorway. */
export const DOOR_TOP = DOOR_HEIGHT + FRAME;
/** Widest a name above a door may get, so neighbouring labels never touch. */
const MAX_LABEL_WIDTH = 4;
/** How far occupied doors spill god-rays into the hall. */
const RAY_LENGTH = 2.05;
/** Keep the shaft off the floor so the glow sits in the opening, not on the tiles. */
const RAY_CLEARANCE = 0.02;
/** Far end is wider than the doorway; a little taller, not as much. */
const RAY_FLARE_W = 1.18;
const RAY_FLARE_H = 1.06;

/**
 * Open-bottom trapezoid: door-sized at the opening, larger out in the hall.
 * The sill stays level so the far end does not dip into the floor.
 */
function openBottomTrapeze(nearW: number, nearH: number, farW: number, farH: number, depth: number): BufferGeometry {
  const z0 = -depth / 2;
  const z1 = depth / 2;
  const nx = nearW / 2;
  const ny = nearH / 2;
  const fx = farW / 2;
  const bottom = -ny;
  const farTop = bottom + farH;
  const positions = new Float32Array([
    -nx, bottom, z0, -nx, ny, z0, nx, ny, z0, nx, bottom, z0,
    -fx, bottom, z1, -fx, farTop, z1, fx, farTop, z1, fx, bottom, z1,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    1, 2, 6, 1, 6, 5,
    4, 5, 6, 4, 6, 7,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

const portalVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const portalFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec2 uFit;
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uOpen;
  uniform float uGlow;
  uniform float uEmpty;
  uniform float uLight;
  uniform float uHover;
  uniform float uRandom;
  varying vec2 vUv;

  // An empty doorway: a plain recess with a soft "+" asking to be filled.
  vec3 emptyDoor(vec2 p) {
    vec3 base = mix(vec3(0.01), vec3(0.78, 0.8, 0.84), uLight);
    vec3 ink = mix(vec3(0.55), vec3(0.4, 0.45, 0.56), uLight);
    // Shade toward the edges so it reads as depth, not a sticker.
    float edge = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
    vec3 color = base * (1.0 - 0.18 * smoothstep(0.4, 1.0, edge));
    vec2 q = vec2(p.x * ${(DOOR_WIDTH / DOOR_HEIGHT).toFixed(4)}, p.y);
    float bar = 0.012;
    float arm = 0.1;
    float plus = max(
      step(abs(q.x), bar) * step(abs(q.y), arm),
      step(abs(q.y), bar) * step(abs(q.x), arm)
    );
    float breathe = 0.55 + 0.25 * sin(uTime * 1.6) + 0.35 * uHover;
    return mix(color, ink, plus * breathe);
  }

  // The random door: a slow blue whirlpool, bright at the heart.
  vec3 randomDoor(vec2 p) {
    vec2 q = vec2(p.x / 0.54, p.y);
    float r = length(q);
    float a = atan(q.y, q.x);
    float swirl = 0.5 + 0.5 * sin(a * 3.0 + 9.0 * r - uTime * 2.2);
    float fine = 0.5 + 0.5 * sin(a * 7.0 - 16.0 * r + uTime * 1.3);
    vec3 deep = vec3(0.01, 0.05, 0.18);
    vec3 bright = vec3(0.3, 0.72, 1.0);
    float fall = 1.0 - smoothstep(0.0, 1.0, r);
    vec3 color = mix(deep, bright, (swirl * 0.75 + fine * 0.25) * fall);
    color += vec3(0.55, 0.85, 1.0) * 0.12 / (r * 4.0 + 0.12) * (0.85 + 0.15 * sin(uTime * 2.0));
    return color;
  }

  void main() {
    vec2 p = vUv - 0.5;
    if (uRandom > 0.5) {
      vec3 color = randomDoor(p);
      float edge = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
      color = mix(color, vec3(0.55, 0.85, 1.0), smoothstep(0.8, 1.0, edge) * 0.6);
      color += uGlow * 0.6;
      gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
      #include <colorspace_fragment>
      return;
    }
    if (uEmpty > 0.5) {
      gl_FragColor = vec4(emptyDoor(p) + uGlow * 0.3, 1.0);
      #include <colorspace_fragment>
      return;
    }
    // The world on the other side, gently breathing.
    vec2 q = p * uFit * (1.0 - 0.05 * uOpen - 0.02 * sin(uTime * 0.7)) + 0.5;
    vec3 far = texture2D(uMap, q).rgb;

    // No preview image: light receding down a corridor in the world's tint.
    float depth = max(abs(p.x) * 2.0 / 0.54, abs(p.y) * 2.0);
    float bands = 0.5 + 0.5 * sin(9.0 / (depth + 0.15) - uTime * 2.2);
    vec3 corridor = mix(uTint * 0.12, uTint, bands * (1.0 - depth * 0.6));

    vec3 color = mix(corridor, far, uHasMap);
    // Light spilling in around the edges of the opening.
    float edge = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
    color = mix(color, uTint * 0.55, smoothstep(0.88, 1.0, edge) * 0.22 * uOpen);
    color *= 0.6 + 0.4 * uOpen;
    color += uTint * uGlow * 0.6;

    gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * A doorway to one listed world, set into the lobby wall and showing the
 * world's cover. Walking into it travels there.
 *
 * Without a world it is an empty door: a closed, plain opening waiting for
 * someone to add theirs. It cannot be walked through.
 *
 * Local +Z faces the room; the wall runs along local X at z = 0.
 */
/** The random door's blue, for its frame, halo and name. */
const RANDOM_BLUE = 0x4db2ff;

export class Door {
  readonly group = new Group();
  readonly world: DoorWorld | null;
  /** Leads to a different listed world each time, picked on the way in. */
  readonly random: boolean;

  private portal: Mesh<PlaneGeometry, ShaderMaterial>;
  private frameMaterial: MeshStandardMaterial;
  private geometries: BufferGeometry[] = [];
  private label: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private drawLabel: (light: boolean) => void;
  private chips: { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; draw: (light: boolean) => void } | null = null;
  /** The gate number over the name, for doors in the hall. */
  private gate: { number: number; mesh: Mesh<PlaneGeometry, MeshBasicMaterial> } | null = null;
  private cover: Texture | null = null;
  private placeholder: Texture;
  private halo: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  private rays: Mesh<BufferGeometry, ShaderMaterial>[] = [];
  private rayTime: { value: number } | null = null;
  private rayTheme: { value: number } | null = null;
  private rayTint: Color | null = null;
  private light: boolean;
  private entries: number | undefined;
  private disposed = false;

  constructor(world: DoorWorld | null, light: boolean, random = false) {
    this.world = world;
    this.random = random;
    this.light = light;
    this.group.name = random ? 'door:random' : world ? `door:${world.name}` : 'door:empty';

    const tint = random
      ? new Color(RANDOM_BLUE)
      : new Color(world?.color ?? '#ffffff');
    const shared = {
      uTint: { value: tint },
      uTime: { value: 0 },
      uOpen: { value: 1 },
      uGlow: { value: 0 },
      uLight: { value: light ? 1 : 0 },
      uEmpty: { value: world ? 0 : 1 },
      uHover: { value: 0 },
      uRandom: { value: random ? 1 : 0 },
    };

    this.frameMaterial = new MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 });

    const box = (w: number, h: number, d: number, material: Material, x: number, y: number, z: number, parent: Group) => {
      const geometry = new BoxGeometry(w, h, d);
      this.geometries.push(geometry);
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // Frame: two posts and a lintel around the opening.
    const postHeight = DOOR_HEIGHT + FRAME;
    for (const side of [-1, 1]) {
      box(FRAME, postHeight, DEPTH, this.frameMaterial, side * (DOOR_WIDTH + FRAME) / 2, postHeight / 2, 0, this.group);
    }
    box(DOOR_WIDTH + FRAME * 2, FRAME, DEPTH, this.frameMaterial, 0, DOOR_HEIGHT + FRAME / 2, 0, this.group);

    // The world on the other side fills the doorway.
    this.placeholder = new Texture();
    this.portal = new Mesh(
      new PlaneGeometry(DOOR_WIDTH, DOOR_HEIGHT),
      new ShaderMaterial({
        vertexShader: portalVertex,
        fragmentShader: portalFragment,
        uniforms: {
          ...shared,
          uMap: { value: this.placeholder },
          uHasMap: { value: 0 },
          uFit: { value: new Vector2(1, 1) },
        },
        side: DoubleSide,
      }),
    );
    this.portal.position.set(0, DOOR_HEIGHT / 2, -0.02);
    this.group.add(this.portal);

    if (world || random) {
      const rayTime = { value: 0 };
      const rayTheme = { value: light ? 1 : 0 };
      const rayPresence = { value: 1 };
      this.rayTime = rayTime;
      this.rayTheme = rayTheme;
      const rayTint = tint;
      this.rayTint = rayTint;
      const rayHeight = DOOR_HEIGHT - RAY_CLEARANCE;
      const farW = DOOR_WIDTH * RAY_FLARE_W;
      const farH = rayHeight * RAY_FLARE_H;
      const ray = new Mesh(
        openBottomTrapeze(DOOR_WIDTH, rayHeight, farW, farH, RAY_LENGTH),
        createGodRayMaterial({
          length: RAY_LENGTH,
          gain: 0.7,
          time: rayTime,
          theme: rayTheme,
          presence: rayPresence,
          tint: rayTint,
          square: { width: farW, height: farH },
        }),
      );
      ray.position.set(0, RAY_CLEARANCE + rayHeight / 2, RAY_LENGTH / 2);
      ray.renderOrder = 2;
      ray.frustumCulled = false;
      this.group.add(ray);
      this.rays.push(ray);
    }

    if (random) {
      // A soft blue glow spilling around the frame.
      this.halo = createHalo();
      this.halo.position.set(0, DOOR_HEIGHT / 2, -0.06);
      this.group.add(this.halo);
    }

    const label = random
      ? createLabel('Random Door', undefined, false, 'Somewhere new every time')
      : world
        ? createLabel(world.name, world.creator, false, undefined, () => this.entries)
        : createLabel('Claim this portal', undefined, true);
    this.label = label.mesh;
    this.drawLabel = label.draw;
    // Painted on the wall above the doorway; far enough out that long names
    // clear the wall's curve.
    this.label.position.set(0, DOOR_HEIGHT + FRAME + 1.2, 0.25);
    // The random door has a porch canopy over it: sit its name on top.
    if (random) this.label.position.set(0, DOOR_HEIGHT + FRAME + 3.1, 0.3);
    this.group.add(this.label);

    // What the world offers (multiplayer, VR, ...), as chips between its name and the doorway.
    const features = world && !random ? doorFeatures(world.tags) : [];
    if (features.length) {
      this.chips = createChips(features);
      this.chips.mesh.position.z = 0.25;
      this.group.add(this.chips.mesh);
    }

    this.setTheme(light);
    if (world?.cover) this.loadCover(world.cover);
  }

  get empty(): boolean {
    return this.world === null && !this.random;
  }

  /**
   * The doorway's face. An empty door is closed, so this doubles as the
   * collider that stops people walking into it, and as the tap target.
   */
  get face(): Mesh {
    return this.portal;
  }

  /** How many times people have gone through: shown beside the creator under the name. */
  setEntries(count: number | undefined): void {
    if (!this.world || this.random) return;
    const next = Number(count);
    const shown = Number.isFinite(next) && next >= 0 ? next : undefined;
    if (shown === this.entries) return;
    this.entries = shown;
    this.drawLabel(this.light);
  }

  /** Show this door's gate number above its name; null takes it down. */
  setGate(gate: number | null): void {
    if (this.gate?.number === gate) return;
    if (this.gate) {
      this.gate.mesh.material.map?.dispose();
      this.gate.mesh.material.dispose();
      this.gate.mesh.geometry.dispose();
      this.gate.mesh.removeFromParent();
      this.gate = null;
    }
    if (gate === null) return;
    const mesh = createGateBadge(gate);
    mesh.position.z = 0.26;
    this.group.add(mesh);
    this.gate = { number: gate, mesh };
    this.stackLabel();
  }

  /** Brighten the "+" while someone is close enough to use it. */
  setHover(hover: boolean): void {
    this.portal.material.uniforms.uHover.value = hover ? 1 : 0;
  }

  /** How far (x, z) stands in front of the doorway, or null if off to the side. */
  distanceInFront(x: number, z: number): number | null {
    const { localX, localZ } = this.toLocal(x, z);
    if (Math.abs(localX) > DOOR_WIDTH || localZ < 0) return null;
    return localZ;
  }

  /** Stand the door at (x, z), facing the point (towardX, towardZ). */
  place(x: number, z: number, towardX: number, towardZ: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = Math.atan2(towardX - x, towardZ - z);
  }

  /** The point `distance` straight out in front of the doorway, and the yaw that looks away from it. */
  inFront(distance: number): { x: number; z: number; yaw: number } {
    const angle = this.group.rotation.y;
    return {
      x: this.group.position.x + Math.sin(angle) * distance,
      z: this.group.position.z + Math.cos(angle) * distance,
      yaw: angle + Math.PI,
    };
  }

  /** True once (x, z) has walked into the doorway. */
  contains(x: number, z: number): boolean {
    const { localX, localZ } = this.toLocal(x, z);
    return Math.abs(localX) < DOOR_WIDTH / 2 && localZ < THRESHOLD && localZ > -REACH;
  }

  private toLocal(x: number, z: number): { localX: number; localZ: number } {
    const dx = x - this.group.position.x;
    const dz = z - this.group.position.z;
    const angle = this.group.rotation.y;
    return {
      localX: dx * Math.cos(angle) - dz * Math.sin(angle),
      localZ: dx * Math.sin(angle) + dz * Math.cos(angle),
    };
  }

  update(time: number): void {
    this.stackLabel();
    this.portal.material.uniforms.uTime.value = time;
    if (this.rayTime) this.rayTime.value = time;
  }

  setTheme(light: boolean): void {
    this.light = light;
    this.portal.material.uniforms.uLight.value = light ? 1 : 0;
    if (this.rayTheme) this.rayTheme.value = light ? 1 : 0;
    // White doors on the black grid, ink doors on the white one.
    this.frameMaterial.color.set(light ? 0x1c1c1c : 0xf2f2f2);
    if (this.random) {
      this.frameMaterial.color.set(light ? 0x1a5fa8 : 0xbfe4ff);
      this.frameMaterial.emissive.set(RANDOM_BLUE);
      this.frameMaterial.emissiveIntensity = light ? 0.35 : 0.8;
      this.halo!.material.opacity = light ? 0.55 : 0.9;
    }
    this.drawLabel(light);
    this.chips?.draw(light);
    this.stackLabel();
  }

  /**
   * With chips under the name, lift the name to sit just above them. Run
   * every frame because a late font load redraws (and resizes) either one.
   */
  private stackLabel(): void {
    const chipTop = this.chips ? CHIP_BOTTOM + this.chips.mesh.scale.y : 0;
    if (this.gate) {
      // In the hall, gate numbers and names line up along the wall: every
      // name hangs from the same height under its gate, with any chips in
      // the space below it. Only an unusually tall stack pushes them higher.
      const nameTop = Math.max(NAME_TOP, chipTop + LABEL_GAP + this.label.scale.y);
      this.label.position.y = nameTop - this.label.scale.y / 2;
      this.gate.mesh.position.y = Math.max(GATE_Y, nameTop + GATE_GAP + this.gate.mesh.scale.y / 2);
    } else if (this.chips) {
      this.label.position.y = chipTop + LABEL_GAP + this.label.scale.y / 2;
    }
  }

  /** Flare the light while we travel through it. */
  surge(amount = 1): void {
    this.portal.material.uniforms.uGlow.value = amount;
  }

  settle(): void {
    this.portal.material.uniforms.uGlow.value = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.portal.geometry.dispose();
    this.portal.material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.frameMaterial.dispose();
    this.halo?.geometry.dispose();
    this.halo?.material.map?.dispose();
    this.halo?.material.dispose();
    for (const mesh of this.rays) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.label.material.map?.dispose();
    this.label.geometry.dispose();
    this.label.material.dispose();
    this.setGate(null);
    if (this.chips) {
      this.chips.mesh.material.map?.dispose();
      this.chips.mesh.geometry.dispose();
      this.chips.mesh.material.dispose();
    }
    this.cover?.dispose();
    this.placeholder.dispose();
    this.group.removeFromParent();
  }

  private async loadCover(src: string): Promise<void> {
    const texture = await loadCoverTexture(src);
    if (!texture) return;
    if (this.disposed) {
      texture.dispose();
      return;
    }
    const image = texture.image as { width: number; height: number };
    const aspect = image.width / image.height;
    const doorway = DOOR_WIDTH / DOOR_HEIGHT;
    // Crop the cover to the doorway's shape, whatever its own.
    const fit = aspect > doorway ? new Vector2(doorway / aspect, 1) : new Vector2(1, aspect / doorway);
    const uniforms = this.portal.material.uniforms;
    uniforms.uMap.value = texture;
    uniforms.uFit.value = fit;
    uniforms.uHasMap.value = 1;
    this.cover = texture;
    const sampled = colorFromCover(texture.image);
    if (sampled) {
      this.rayTint?.copy(sampled);
      this.portal.material.uniforms.uTint.value.copy(sampled);
    }
  }
}

/** Average colour of a cover, lifted so additive shafts still read at a distance. */
function colorFromCover(image: unknown): Color | null {
  if (!image || typeof image !== 'object' || !('width' in image) || !('height' in image)) return null;
  const source = image as CanvasImageSource & { width: number; height: number };
  if (!source.width || !source.height) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i] / 255;
      const pg = data[i + 1] / 255;
      const pb = data[i + 2] / 255;
      const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      if (lum < 0.06) continue;
      const w = 0.35 + lum;
      r += pr * w;
      g += pg * w;
      b += pb * w;
      weight += w;
    }
    if (weight < 1e-4) return null;
    const color = new Color(r / weight, g / weight, b / weight);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    color.setHSL(hsl.h, Math.min(1, Math.max(0.42, hsl.s * 1.2)), Math.min(0.62, Math.max(0.4, hsl.l)));
    return color;
  } catch {
    return null;
  }
}

/**
 * Covers live on other hosts. WebGL needs CORS to read them, so try the hub's
 * same-origin cover proxy first, then the image directly. If neither works
 * the door shows a procedural corridor instead.
 */
export async function loadCoverTexture(src: string): Promise<Texture | null> {
  const candidates: string[] = [];
  if (src.startsWith('data:')) {
    candidates.push(src);
  } else try {
    const url = new URL(src, window.location.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== window.location.origin) {
      candidates.push(`/api/cover?url=${encodeURIComponent(url.toString())}`);
    }
    candidates.push(url.toString());
  } catch {
    return null;
  }

  const loader = new TextureLoader();
  loader.setCrossOrigin('anonymous');
  for (const candidate of candidates) {
    try {
      const texture = await loader.loadAsync(candidate);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.generateMipmaps = false;
      return texture;
    } catch {
      // Try the next source.
    }
  }
  return null;
}

/** A soft rounded glow a little larger than the doorway, drawn additively. */
function createHalo(): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const blue = new Color(RANDOM_BLUE);
  const rgb = `${Math.round(blue.r * 255)}, ${Math.round(blue.g * 255)}, ${Math.round(blue.b * 255)}`;
  // Stretch a round gradient to the doorway's tall shape.
  ctx.scale(1, 2);
  const gradient = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
  gradient.addColorStop(0, `rgba(${rgb}, 0.9)`);
  gradient.addColorStop(0.5, `rgba(${rgb}, 0.35)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: false,
  });
  return new Mesh(new PlaneGeometry(DOOR_WIDTH + 4.8, DOOR_HEIGHT + 4.8), material);
}

export function createLabel(
  name: string,
  creator?: string,
  quiet = false,
  subtitle?: string,
  entries: () => number | undefined = () => undefined,
): { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; draw: (light: boolean) => void } {
  const canvas = document.createElement('canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  let light = false;

  const draw = (isLight: boolean) => {
    light = isLight;
    const ctx = canvas.getContext('2d')!;
    const titleFont = '600 88px Urbanist, ui-sans-serif, system-ui, sans-serif';
    const subFont = '500 44px Urbanist, ui-sans-serif, system-ui, sans-serif';
    const title = name.length > 32 ? `${name.slice(0, 31)}…` : name;
    const sub = subtitle ?? (creator ? `by ${creator}`.slice(0, 48) : '');
    const countRaw = entries();
    const count = typeof countRaw === 'number' ? countRaw : Number(countRaw);
    const shown = Number.isFinite(count) && count >= 0;
    // The entries count sits on the second line, after the creator.
    const iconSize = 38;
    const iconGap = 12;
    const runGap = sub ? 34 : 0;

    ctx.font = titleFont;
    const titleLines = title.split('\n');
    const titleWidth = Math.max(...titleLines.map((line) => ctx.measureText(line).width));
    ctx.font = subFont;
    const measuredSub = sub ? ctx.measureText(sub).width : 0;
    const measuredEntries = shown ? measureEntries(ctx, count, iconSize, iconGap) : 0;
    const measuredLine = measuredSub + (shown ? runGap + measuredEntries : 0);
    const secondLine = !!sub || shown;
    const titleLine = 96;
    const titleBlock = titleLines.length > 1 ? 40 + titleLine * titleLines.length : 120;
    const subY = titleLines.length > 1 ? titleBlock + 32 : 152;

    canvas.width = Math.ceil(Math.max(titleWidth, measuredLine) + 64);
    canvas.height = Math.ceil(secondLine ? Math.max(subY + 36, 200) : titleBlock);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = light ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 12;
    ctx.font = titleFont;
    ctx.fillStyle = quiet ? (light ? 'rgba(0, 0, 0, 0.38)' : 'rgba(255, 255, 255, 0.4)') : light ? '#111111' : '#ffffff';
    if (subtitle) {
      // The random door's name glows blue.
      ctx.fillStyle = light ? '#1a6fd0' : '#8fd0ff';
      ctx.shadowColor = light ? 'rgba(255, 255, 255, 0.9)' : 'rgba(77, 178, 255, 0.9)';
      ctx.shadowBlur = 24;
    }
    titleLines.forEach((line, i) => {
      ctx.fillText(line, canvas.width / 2, 92 + i * titleLine);
    });
    if (secondLine) {
      ctx.font = subFont;
      const color = light ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)';
      ctx.fillStyle = color;
      ctx.shadowBlur = 8;
      ctx.textAlign = 'left';
      const subTextWidth = sub ? ctx.measureText(sub).width : 0;
      const entriesWidth = shown ? measureEntries(ctx, count, iconSize, iconGap) : 0;
      const subWidth = subTextWidth + (shown ? runGap + entriesWidth : 0);
      const left = (canvas.width - subWidth) / 2;
      if (sub) ctx.fillText(sub, left, subY);
      if (shown) drawEntries(ctx, count, left + subTextWidth + runGap, subY, iconSize, iconGap, color);
      ctx.textAlign = 'center';
    }

    texture.needsUpdate = true;
    let worldHeight = quiet ? (titleLines.length > 2 ? 1.55 : titleLines.length > 1 ? 1.2 : 0.62) : secondLine ? 1.15 : 0.82;
    // Long names shrink rather than run into the next door's label.
    worldHeight = Math.min(worldHeight, (MAX_LABEL_WIDTH * canvas.height) / canvas.width);
    mesh.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  };

  // The page font may still be loading the first time walk mode opens.
  if (document.fonts && !document.fonts.check('600 88px Urbanist')) {
    document.fonts.load('600 88px Urbanist').then(() => draw(light), () => {});
  }
  return { mesh, draw };
}

/** The gate badge's height, and the space between it and the name below. */
const GATE_HEIGHT = 0.4;
const GATE_GAP = 0.02;
/** Where every gate number's centre sits, and the top of every name under it. */
const GATE_Y = DOOR_TOP + 2.1;
const NAME_TOP = GATE_Y - GATE_HEIGHT / 2 - GATE_GAP;

/**
 * "GATE 12" as a small sign: amber on a dark pill, like the departures board
 * and the concourse signs, in either theme.
 */
function createGateBadge(gate: number): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 64px Urbanist, ui-sans-serif, system-ui, sans-serif';
  const height = 104;
  const draw = () => {
    ctx.font = font;
    const text = `GATE ${gate}`;
    const width = Math.ceil(ctx.measureText(text).width) + 76;
    canvas.width = width;
    canvas.height = height;
    ctx.font = font;
    ctx.fillStyle = '#0d0d10';
    ctx.beginPath();
    ctx.roundRect(2, 2, width - 4, height - 4, (height - 4) / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 194, 61, 0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffc23d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2 + 3);
    texture.needsUpdate = true;
    mesh.scale.set((GATE_HEIGHT * width) / height, GATE_HEIGHT, 1);
  };
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  draw();
  if (document.fonts && !document.fonts.check(font)) document.fonts.load(font).then(draw, () => {});
  return mesh;
}

/** Height of one row of chips on the wall, in metres. */
const CHIP_HEIGHT = 0.46;
/** Where the chips start: just over the door frame, under the name. */
const CHIP_BOTTOM = DOOR_TOP + 0.18;
/** Space between the top row of chips and the name's canvas. */
const LABEL_GAP = -0.12;

/**
 * Outlined pills naming what a world supports, e.g. "Multiplayer", "VR supported".
 * They wrap onto a second row rather than shrink past reading.
 */
function createChips(labels: string[]): { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; draw: (light: boolean) => void } {
  const canvas = document.createElement('canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const geometry = new PlaneGeometry(1, 1);
  // Grow upward from the bottom edge, however many rows there are.
  geometry.translate(0, 0.5, 0);
  const mesh = new Mesh(geometry, material);
  mesh.position.y = CHIP_BOTTOM;
  let light = false;

  const draw = (isLight: boolean) => {
    light = isLight;
    const ctx = canvas.getContext('2d')!;
    const font = '600 40px Urbanist, ui-sans-serif, system-ui, sans-serif';
    const pill = 64;
    const padX = 28;
    const gap = 16;
    const margin = 6;
    const rowStep = pill + gap;
    const maxWidth = (MAX_LABEL_WIDTH * rowStep) / CHIP_HEIGHT;
    ctx.font = font;
    const widths = labels.map((label) => Math.ceil(ctx.measureText(label).width) + padX * 2);
    const rows: number[][] = [];
    widths.forEach((w, i) => {
      const row = rows[rows.length - 1];
      const used = row ? row.reduce((sum, j) => sum + widths[j] + gap, 0) : 0;
      if (row && used + w <= maxWidth) row.push(i);
      else rows.push([i]);
    });
    const rowWidth = (row: number[]) => row.reduce((sum, j) => sum + widths[j], 0) + gap * (row.length - 1);
    canvas.width = Math.max(...rows.map(rowWidth)) + margin * 2;
    canvas.height = rows.length * rowStep - gap + margin * 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    rows.forEach((row, r) => {
      let x = (canvas.width - rowWidth(row)) / 2;
      const y = margin + r * rowStep;
      for (const i of row) {
        const w = widths[i];
        ctx.beginPath();
        ctx.roundRect(x, y, w, pill, pill / 2);
        ctx.fillStyle = light ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.55)';
        ctx.fill();
        ctx.strokeStyle = light ? 'rgba(0, 0, 0, 0.35)' : 'rgba(255, 255, 255, 0.45)';
        ctx.stroke();
        ctx.fillStyle = light ? '#111111' : '#ffffff';
        ctx.fillText(labels[i], x + w / 2, y + pill / 2 + 2);
        x += w + gap;
      }
    });

    texture.needsUpdate = true;
    const metresPerPixel = Math.min(CHIP_HEIGHT / rowStep, MAX_LABEL_WIDTH / canvas.width);
    mesh.scale.set(canvas.width * metresPerPixel, canvas.height * metresPerPixel, 1);
  };

  if (document.fonts && !document.fonts.check('600 40px Urbanist')) {
    document.fonts.load('600 40px Urbanist').then(() => draw(light), () => {});
  }
  return { mesh, draw };
}

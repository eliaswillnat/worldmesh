import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
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
  type BufferGeometry,
  type Material,
} from 'three';

export interface DoorWorld {
  name: string;
  url: string;
  cover?: string;
  color?: string;
  creator?: string;
}

/** Size of the doorway opening, in metres. */
const DOOR_WIDTH = 1.4;
const DOOR_HEIGHT = 2.6;
/** Frame thickness and depth. */
const FRAME = 0.16;
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
const MAX_LABEL_WIDTH = 3.3;

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
    vec3 base = mix(vec3(0.07), vec3(0.9, 0.915, 0.94), uLight);
    vec3 ink = mix(vec3(0.8), vec3(0.45, 0.5, 0.62), uLight);
    // Shade toward the edges so it reads as depth, not a sticker.
    float edge = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
    vec3 color = base * (1.0 - 0.18 * smoothstep(0.4, 1.0, edge));
    vec2 q = vec2(p.x * 0.54, p.y);
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
    color = mix(color, vec3(1.0), smoothstep(0.82, 1.0, edge) * 0.4 * uOpen);
    color *= 0.6 + 0.4 * uOpen;
    color += uGlow * 0.6;

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
  private cover: Texture | null = null;
  private placeholder: Texture;
  private halo: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  private disposed = false;

  constructor(world: DoorWorld | null, light: boolean, random = false) {
    this.world = world;
    this.random = random;
    this.group.name = random ? 'door:random' : world ? `door:${world.name}` : 'door:empty';

    const tint = new Color(world?.color ?? '#ffffff');
    // Keep the lobby monochrome-ish: only a hint of the world's colour.
    tint.lerp(new Color(0xffffff), 0.45);
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

    if (random) {
      // A soft blue glow spilling around the frame.
      this.halo = createHalo();
      this.halo.position.set(0, DOOR_HEIGHT / 2, -0.06);
      this.group.add(this.halo);
    }

    const label = random
      ? createLabel('Random Door', undefined, false, 'Somewhere new every time')
      : world
        ? createLabel(world.name, world.creator)
        : createLabel('Your world here', undefined, true);
    this.label = label.mesh;
    this.drawLabel = label.draw;
    // Painted on the wall above the doorway; far enough out that long names
    // clear the wall's curve.
    this.label.position.set(0, DOOR_HEIGHT + FRAME + 0.6, 0.25);
    // The random door has a porch canopy over it: sit its name on top.
    if (random) this.label.position.set(0, DOOR_HEIGHT + FRAME + 1.55, 0.3);
    this.group.add(this.label);

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
    this.portal.material.uniforms.uTime.value = time;
  }

  setTheme(light: boolean): void {
    this.portal.material.uniforms.uLight.value = light ? 1 : 0;
    // White doors on the black grid, ink doors on the white one.
    this.frameMaterial.color.set(light ? 0x1c1c1c : 0xf2f2f2);
    if (this.random) {
      this.frameMaterial.color.set(light ? 0x1a5fa8 : 0xbfe4ff);
      this.frameMaterial.emissive.set(RANDOM_BLUE);
      this.frameMaterial.emissiveIntensity = light ? 0.35 : 0.8;
      this.halo!.material.opacity = light ? 0.55 : 0.9;
    }
    this.drawLabel(light);
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
    this.label.material.map?.dispose();
    this.label.geometry.dispose();
    this.label.material.dispose();
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
  }
}

/**
 * Covers live on other hosts. WebGL needs CORS to read them, so try the hub's
 * same-origin cover proxy first, then the image directly. If neither works
 * the door shows a procedural corridor instead.
 */
async function loadCoverTexture(src: string): Promise<Texture | null> {
  const candidates: string[] = [];
  try {
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
  return new Mesh(new PlaneGeometry(DOOR_WIDTH + 2.4, DOOR_HEIGHT + 2.4), material);
}

function createLabel(
  name: string,
  creator?: string,
  quiet = false,
  subtitle?: string,
): { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; draw: (light: boolean) => void } {
  const canvas = document.createElement('canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
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

    ctx.font = titleFont;
    const titleWidth = ctx.measureText(title).width;
    ctx.font = subFont;
    const subWidth = sub ? ctx.measureText(sub).width : 0;

    canvas.width = Math.ceil(Math.max(titleWidth, subWidth) + 48);
    canvas.height = sub ? 170 : 120;

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
    ctx.fillText(title, canvas.width / 2, 92);
    if (sub) {
      ctx.font = subFont;
      ctx.fillStyle = light ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)';
      ctx.fillText(sub, canvas.width / 2, 152);
    }

    texture.needsUpdate = true;
    let worldHeight = quiet ? 0.5 : sub ? 0.95 : 0.67;
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

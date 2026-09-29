import {
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
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - 0.5;
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
 * Local +Z faces the room; the wall runs along local X at z = 0.
 */
export class Door {
  readonly group = new Group();
  readonly world: DoorWorld;

  private portal: Mesh<PlaneGeometry, ShaderMaterial>;
  private frameMaterial: MeshStandardMaterial;
  private geometries: BufferGeometry[] = [];
  private label: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private drawLabel: (light: boolean) => void;
  private cover: Texture | null = null;
  private placeholder: Texture;
  private disposed = false;

  constructor(world: DoorWorld, light: boolean) {
    this.world = world;
    this.group.name = `door:${world.name}`;

    const tint = new Color(world.color ?? '#ffffff');
    // Keep the lobby monochrome-ish: only a hint of the world's colour.
    tint.lerp(new Color(0xffffff), 0.45);
    const shared = {
      uTint: { value: tint },
      uTime: { value: 0 },
      uOpen: { value: 1 },
      uGlow: { value: 0 },
      uLight: { value: light ? 1 : 0 },
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

    const label = createLabel(world.name, world.creator);
    this.label = label.mesh;
    this.drawLabel = label.draw;
    // Painted on the wall above the doorway; far enough out that long names
    // clear the wall's curve.
    this.label.position.set(0, DOOR_HEIGHT + FRAME + 0.6, 0.25);
    this.group.add(this.label);

    this.setTheme(light);
    if (world.cover) this.loadCover(world.cover);
  }

  /** Stand the door at (x, z), facing the point (towardX, towardZ). */
  place(x: number, z: number, towardX: number, towardZ: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = Math.atan2(towardX - x, towardZ - z);
  }

  /** True once (x, z) has walked into the doorway. */
  contains(x: number, z: number): boolean {
    const dx = x - this.group.position.x;
    const dz = z - this.group.position.z;
    const angle = this.group.rotation.y;
    const localX = dx * Math.cos(angle) - dz * Math.sin(angle);
    const localZ = dx * Math.sin(angle) + dz * Math.cos(angle);
    return Math.abs(localX) < DOOR_WIDTH / 2 && localZ < THRESHOLD && localZ > -REACH;
  }

  update(time: number): void {
    this.portal.material.uniforms.uTime.value = time;
  }

  setTheme(light: boolean): void {
    this.portal.material.uniforms.uLight.value = light ? 1 : 0;
    // White doors on the black grid, ink doors on the white one.
    this.frameMaterial.color.set(light ? 0x1c1c1c : 0xf2f2f2);
    this.drawLabel(light);
  }

  /** Flare the light while we travel through it. */
  surge(): void {
    this.portal.material.uniforms.uGlow.value = 1;
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

function createLabel(name: string, creator?: string): { mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; draw: (light: boolean) => void } {
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
    const sub = creator ? `by ${creator}`.slice(0, 48) : '';

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
    ctx.fillStyle = light ? '#111111' : '#ffffff';
    ctx.fillText(title, canvas.width / 2, 92);
    if (sub) {
      ctx.font = subFont;
      ctx.fillStyle = light ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)';
      ctx.fillText(sub, canvas.width / 2, 152);
    }

    texture.needsUpdate = true;
    const worldHeight = sub ? 0.95 : 0.67;
    mesh.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  };

  // The page font may still be loading the first time walk mode opens.
  if (document.fonts && !document.fonts.check('600 88px Urbanist')) {
    document.fonts.load('600 88px Urbanist').then(() => draw(light), () => {});
  }
  return { mesh, draw };
}

import {
  BackSide,
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
  TextureLoader,
  Vector2,
  type Vector3,
} from 'three';

export interface WormholeWorld {
  name: string;
  url: string;
  cover?: string;
  color?: string;
  creator?: string;
}

/** Radius of the sphere, in metres. */
export const WORMHOLE_RADIUS = 1.2;
/** Walk within this distance of the wormhole's centre to go through. */
export const WORMHOLE_TRIGGER = 1.3;
/** Gap between the bottom of the sphere and the grid. */
const FLOAT = 0.03;
/** How far the halo reaches, as a multiple of the sphere radius. */
const HALO = 1.5;

const sphereVertex = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const sphereFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec2 uFit;
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uNear;
  uniform float uSeed;
  uniform float uLight;
  varying vec3 vNormalV;
  varying vec3 vViewV;

  void main() {
    vec3 n = normalize(vNormalV);
    vec3 v = normalize(vViewV);
    float facing = clamp(dot(n, v), 0.0, 1.0);
    // 0 at the middle of the sphere as seen from here, 1 at its outline.
    float r = sqrt(1.0 - facing * facing);
    float a = atan(n.y, n.x);
    float t = uTime + uSeed * 10.0;

    // Lensing: the far world is magnified in the middle and wrung out into a
    // spiral toward the edge, like light bending around the horizon.
    float edge = smoothstep(0.3, 1.0, r);
    float ang = a + edge * edge * (2.4 + uNear * 2.5) + t * (0.15 + uNear * 0.5) * edge;
    float rr = r * (0.62 + 0.38 * r * r);
    vec2 q = vec2(cos(ang), sin(ang)) * rr * 0.5;
    vec3 far = texture2D(uMap, 0.5 + q * uFit).rgb;

    // No preview image: a tunnel in the world's tint.
    float bands = 0.5 + 0.5 * sin(7.0 / (r + 0.12) - t * 2.5 + ang * 2.0);
    vec3 tunnel = mix(uTint * 0.08, uTint * 0.8, bands * (1.0 - r * 0.4));

    vec3 color = mix(tunnel, far, uHasMap);
    // The horizon swallows light toward the outline.
    color *= mix(1.0, 0.05, pow(edge, 1.6));

    // Photon ring hugging the outline: light on a dark world, ink on a light one.
    vec3 rim = mix(mix(vec3(1.0), uTint, 0.35), vec3(0.03), uLight);
    float ring = clamp(pow(r, 28.0) * (1.2 + uNear * 0.8), 0.0, 1.0);
    color = mix(color, rim, ring);

    // A glassy highlight so it reads as a ball, not a disc.
    vec3 lightDir = normalize(vec3(-0.45, 0.75, 0.5));
    float spec = pow(max(dot(reflect(-lightDir, n), v), 0.0), 70.0);
    color += vec3(0.55 * spec);

    gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
    #include <colorspace_fragment>
  }
`;

const haloFragment = /* glsl */ `
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uNear;
  uniform float uSeed;
  uniform float uLight;
  varying vec3 vNormalV;
  varying vec3 vViewV;

  const float HALO = ${HALO.toFixed(2)};

  void main() {
    // Drawn on the inside of a larger sphere: turn the angle back into a
    // distance from the wormhole's centre, in wormhole radii.
    float facing = dot(normalize(vNormalV), normalize(vViewV));
    float d = sqrt(max(0.0, 1.0 - facing * facing)) * HALO;
    float a = atan(vNormalV.y, vNormalV.x);
    float t = uTime + uSeed * 10.0;

    // Streaky accretion glow swirling around the outside.
    float streak = 0.55 + 0.45 * sin(a * 5.0 - d * 7.0 + t * 1.8) * sin(a * 3.0 - t * 0.9);
    float glow = exp(-max(d - 1.0, 0.0) * 3.2) * 0.5 * streak * (1.0 + uNear * 1.2);
    glow *= 1.0 - smoothstep(HALO * 0.8, HALO, d);
    glow = clamp(glow * mix(1.0, 0.7, uLight), 0.0, 1.0);

    vec3 color = mix(mix(vec3(1.0), uTint, 0.35), vec3(0.05), uLight);
    gl_FragColor = vec4(color * glow, glow);
    #include <colorspace_fragment>
  }
`;

const padVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const padFragment = /* glsl */ `
  uniform float uTime;
  uniform float uNear;
  uniform float uLight;
  uniform vec3 uTint;
  varying vec2 vUv;

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float edge = exp(-abs(r - 0.9) * 40.0);
    // Ripples running inward, toward the wormhole.
    float ripples = pow(0.5 + 0.5 * sin(r * 20.0 + uTime * 4.0), 10.0) * (1.0 - r) * 0.6;
    float a = clamp((edge * 0.7 + ripples) * (0.35 + uNear * 0.9), 0.0, 1.0);
    vec3 color = mix(mix(vec3(1.0), uTint, 0.35), vec3(0.05), uLight);
    gl_FragColor = vec4(color * a, a);
    #include <colorspace_fragment>
  }
`;

/**
 * A wormhole to one listed world: a sphere floating just above the grid,
 * showing a lensed preview of the world's cover, wrapped in a swirling halo,
 * with a landing ring on the floor and the world's name above.
 */
export class Wormhole {
  readonly group = new Group();
  readonly world: WormholeWorld;

  private sphere: Mesh<SphereGeometry, ShaderMaterial>;
  private halo: Mesh<SphereGeometry, ShaderMaterial>;
  private pad: Mesh<PlaneGeometry, ShaderMaterial>;
  private label: Sprite;
  private drawLabel: (light: boolean) => void;
  private cover: Texture | null = null;
  private placeholder: Texture;
  private disposed = false;

  constructor(world: WormholeWorld, position: Vector3, floorLayer: number, light: boolean) {
    this.world = world;
    this.group.position.copy(position);
    this.group.name = `wormhole:${world.name}`;

    const tint = new Color(world.color ?? '#ffffff');
    // Keep the lobby monochrome-ish: only a hint of the world's colour.
    tint.lerp(new Color(0xffffff), 0.45);
    const seed = Math.random();
    const shared = {
      uTint: { value: tint },
      uTime: { value: 0 },
      uNear: { value: 0 },
      uSeed: { value: seed },
      uLight: { value: light ? 1 : 0 },
    };

    this.placeholder = new Texture();
    const centerY = WORMHOLE_RADIUS + FLOAT;

    this.sphere = new Mesh(
      new SphereGeometry(WORMHOLE_RADIUS, 64, 48),
      new ShaderMaterial({
        vertexShader: sphereVertex,
        fragmentShader: sphereFragment,
        uniforms: {
          ...shared,
          uMap: { value: this.placeholder },
          uHasMap: { value: 0 },
          uFit: { value: new Vector2(1, 1) },
        },
      }),
    );
    this.sphere.position.y = centerY;
    this.group.add(this.sphere);

    this.halo = new Mesh(
      new SphereGeometry(WORMHOLE_RADIUS * HALO, 48, 32),
      new ShaderMaterial({
        vertexShader: sphereVertex,
        fragmentShader: haloFragment,
        // Same objects as the sphere's, so both animate together.
        uniforms: shared,
        side: BackSide,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
      }),
    );
    this.halo.position.y = centerY;
    this.group.add(this.halo);

    this.pad = new Mesh(
      new PlaneGeometry(WORMHOLE_TRIGGER * 2.4, WORMHOLE_TRIGGER * 2.4),
      new ShaderMaterial({
        vertexShader: padVertex,
        fragmentShader: padFragment,
        uniforms: shared,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        // Lying on the floor: win the depth test against it on every GPU.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.pad.rotation.x = -Math.PI / 2;
    this.pad.position.y = 0.01;
    // Flat on the floor: keep it out of the floor's own reflection.
    this.pad.layers.set(floorLayer);
    this.group.add(this.pad);

    const label = createLabel(world.name, world.creator);
    this.label = label.sprite;
    this.drawLabel = label.draw;
    this.drawLabel(light);
    this.label.position.y = centerY + WORMHOLE_RADIUS * 1.25 + 0.55;
    this.group.add(this.label);

    if (world.cover) this.loadCover(world.cover);
  }

  update(time: number, player: Vector3): void {
    const distance = Math.hypot(player.x - this.group.position.x, player.z - this.group.position.z);
    const uniforms = this.sphere.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uNear.value = 1 - smoothstep(1.5, 9, distance);
  }

  setTheme(light: boolean): void {
    this.sphere.material.uniforms.uLight.value = light ? 1 : 0;
    this.drawLabel(light);
  }

  /** Pull the wormhole wide open while we travel through it. */
  surge(): void {
    this.sphere.material.uniforms.uNear.value = 2;
    this.sphere.scale.setScalar(1.25);
    this.halo.scale.setScalar(1.25);
  }

  settle(): void {
    this.sphere.scale.setScalar(1);
    this.halo.scale.setScalar(1);
  }

  dispose(): void {
    this.disposed = true;
    for (const mesh of [this.sphere, this.halo, this.pad]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.label.material.map?.dispose();
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
    // Sample a centred square of the cover, whatever its shape.
    const fit = aspect < 1 ? new Vector2(1, aspect) : new Vector2(1 / aspect, 1);
    const uniforms = this.sphere.material.uniforms;
    uniforms.uMap.value = texture;
    uniforms.uFit.value = fit;
    uniforms.uHasMap.value = 1;
    this.cover = texture;
  }
}

/**
 * Covers live on other hosts. WebGL needs CORS to read them, so try the hub's
 * same-origin cover proxy first, then the image directly. If neither works
 * the wormhole shows a procedural tunnel instead.
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

function createLabel(name: string, creator?: string): { sprite: Sprite; draw: (light: boolean) => void } {
  const canvas = document.createElement('canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new Sprite(material);
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
    sprite.scale.set((canvas.width / canvas.height) * worldHeight, worldHeight, 1);
  };

  // The page font may still be loading the first time walk mode opens.
  if (document.fonts && !document.fonts.check('600 88px Urbanist')) {
    document.fonts.load('600 88px Urbanist').then(() => draw(light), () => {});
  }
  return { sprite, draw };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

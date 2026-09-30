import {
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Vector3,
} from 'three';
import { hash, random, type ScreenPlan } from './layout';

/**
 * What the citadel and the city around it share: the sky dome, the banner
 * over the gate, the light trim, and the billboard slot type the ad system
 * draws on. The city itself (the category towers) lives in ../towers.
 */

const SKY_RADIUS = 250;

// ── Sky ──────────────────────────────────────────────────────────────────────

const skyVertex = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  varying vec3 vDirection;
  void main() {
    float h = clamp(normalize(vDirection).y, 0.0, 1.0);
    // Pale at the horizon, a clean saturated blue overhead.
    vec3 color = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.75, h), 0.55));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Emissive lift for white surfaces in daylight, so their shaded sides stay white. */
export const CITY_GLOW_WHITE = 0x6b707c;

export const SKY_TOP = 0x2f80ea;
export const SKY_HORIZON = 0xc4defb;

/** A plain blue gradient dome. Move it with the player so it never gets closer. */
export function createSky(): Mesh<SphereGeometry, ShaderMaterial> {
  const sky = new Mesh(
    new SphereGeometry(SKY_RADIUS, 32, 16),
    new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uTop: { value: new Color(SKY_TOP) },
        uHorizon: { value: new Color(SKY_HORIZON) },
      },
      side: BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

// ── The citadel's banner ─────────────────────────────────────────────────────

interface PosterSpec {
  lines: string[];
  /** Which headline lines are drawn in the accent colour. */
  accent?: number[];
  sub?: string;
}

/** The citadel's own banner, hung over the gate. The towers' screens are billboards. */
export const CITADEL_POSTER: PosterSpec = {
  lines: ['EXPLORE', 'NEW', 'WORLDS'],
  accent: [1, 2],
  sub: 'IMMERSIVE 3D EXPERIENCES',
};

const HEADLINE_FONT = 'Urbanist, "Arial Narrow", Arial, ui-sans-serif, system-ui, sans-serif';

export interface Poster {
  texture: CanvasTexture;
  material: MeshBasicMaterial;
  redraw(): void;
}

function createPoster(spec: PosterSpec, anisotropy: number): Poster {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 1024;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  // Screens glow: unlit, and never dimmed by tone mapping.
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const redraw = () => {
    drawPoster(canvas.getContext('2d')!, canvas.width, canvas.height, spec);
    texture.needsUpdate = true;
  };
  redraw();
  return { texture, material, redraw };
}

function drawPoster(ctx: CanvasRenderingContext2D, w: number, h: number, spec: PosterSpec): void {
  const rand = random(hash(spec.lines.join()));
  ctx.clearRect(0, 0, w, h);

  // Deep indigo at the top warming to violet and pink at the horizon.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#1c22a6');
  bg.addColorStop(0.45, '#3326c9');
  bg.addColorStop(0.75, '#6a36de');
  bg.addColorStop(1, '#b04fe6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Faint stars.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  for (let i = 0; i < 40; i++) {
    const r = rand() * 1.6 + 0.4;
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h * 0.7, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Art in the lower part of the screen.
  drawPlanet(ctx, { x: 0, y: h * 0.4, w, h: h * 0.6 }, rand);

  // Headline.
  const pad = w * 0.09;
  const textWidth = w - pad * 2;
  const base = w * 0.2;
  let size = base;
  ctx.font = `700 ${size}px ${HEADLINE_FONT}`;
  for (const line of spec.lines) {
    const measured = ctx.measureText(line).width;
    if (measured > textWidth) size = Math.min(size, (base * textWidth) / measured);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(20, 10, 80, 0.5)';
  ctx.shadowBlur = size * 0.2;
  let y = h * 0.06 + size;
  const lineHeight = size * 0.98;
  ctx.font = `700 ${size}px ${HEADLINE_FONT}`;
  spec.lines.forEach((line, i) => {
    ctx.fillStyle = spec.accent?.includes(i) ? '#5ef2ff' : '#ffffff';
    ctx.fillText(line, pad, y);
    y += lineHeight;
  });

  if (spec.sub) {
    const subSize = size * 0.34;
    ctx.font = `600 ${subSize}px ${HEADLINE_FONT}`;
    y += subSize * 0.4;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(spec.sub, pad, y);
    y += subSize * 1.15;
  }

  // Arrow.
  ctx.shadowBlur = 0;
  const arrowY = y + size * 0.05;
  const arrowX = pad;
  const arrowLength = size * 0.6;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(3, size * 0.07);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(arrowX + arrowLength, arrowY);
  ctx.moveTo(arrowX + arrowLength - size * 0.2, arrowY - size * 0.2);
  ctx.lineTo(arrowX + arrowLength, arrowY);
  ctx.lineTo(arrowX + arrowLength - size * 0.2, arrowY + size * 0.2);
  ctx.stroke();

  // A soft glowing edge, like light bleeding at the screen's bezel.
  ctx.strokeStyle = 'rgba(190, 220, 255, 0.45)';
  ctx.lineWidth = Math.max(4, w * 0.012);
  ctx.strokeRect(0, 0, w, h);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A glowing planet over a crystal skyline at sunset. */
function drawPlanet(ctx: CanvasRenderingContext2D, area: Rect, rand: () => number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  const horizon = area.y + area.h * 0.72;

  // Sunset glow on the horizon.
  const glow = ctx.createRadialGradient(area.x + area.w * 0.5, horizon, 0, area.x + area.w * 0.5, horizon, area.w * 0.7);
  glow.addColorStop(0, 'rgba(255, 170, 230, 0.75)');
  glow.addColorStop(1, 'rgba(255, 170, 230, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(area.x, area.y, area.w, area.h);

  const r = Math.min(area.w, area.h) * 0.36;
  const cx = area.x + area.w * 0.62;
  const cy = horizon - area.h * 0.3;
  ctx.shadowColor = 'rgba(160, 200, 255, 0.9)';
  ctx.shadowBlur = r * 0.35;
  const planet = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  planet.addColorStop(0, '#e8f4ff');
  planet.addColorStop(0.45, '#8fb6ff');
  planet.addColorStop(0.85, '#6a55e6');
  planet.addColorStop(1, '#c78cff');
  ctx.fillStyle = planet;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Pale continents.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.ellipse(cx + (rand() - 0.5) * r, cy + (rand() - 0.5) * r, r * (0.1 + rand() * 0.2), r * (0.05 + rand() * 0.1), rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSkyline(ctx, area, horizon, rand);
  ctx.restore();
}

/** Crystal towers on a floating island over water, with their reflection. */
function drawSkyline(ctx: CanvasRenderingContext2D, area: Rect, horizon: number, rand: () => number): void {
  const towers: [number, number, number][] = [];
  const count = Math.round(area.w / 22);
  for (let i = 0; i < count; i++) {
    const x = area.x + area.w * (0.1 + 0.8 * (i / count)) + (rand() - 0.5) * 8;
    const centre = 1 - Math.abs(i / count - 0.55) * 1.6;
    const height = area.h * (0.08 + Math.max(0, centre) * 0.3 * (0.5 + rand() * 0.7));
    towers.push([x, height, 4 + rand() * 10]);
  }

  // Water.
  const water = ctx.createLinearGradient(0, horizon, 0, area.y + area.h);
  water.addColorStop(0, '#6fc3ff');
  water.addColorStop(0.5, '#4d6bf0');
  water.addColorStop(1, '#3a2bc4');
  ctx.fillStyle = water;
  ctx.fillRect(area.x, horizon, area.w, area.y + area.h - horizon);

  for (const flip of [1, -1]) {
    ctx.globalAlpha = flip === 1 ? 1 : 0.35;
    for (const [x, height, width] of towers) {
      const g = ctx.createLinearGradient(0, horizon - height * flip, 0, horizon);
      g.addColorStop(0, '#e0d4ff');
      g.addColorStop(0.3, '#9d7cff');
      g.addColorStop(1, '#4b36c9');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - width / 2, horizon);
      ctx.lineTo(x - width / 2, horizon - height * 0.9 * flip);
      ctx.lineTo(x, horizon - height * flip);
      ctx.lineTo(x + width / 2, horizon - height * 0.9 * flip);
      ctx.lineTo(x + width / 2, horizon);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Green island edge along the shore, with a waterfall.
  ctx.fillStyle = '#2f9d6a';
  ctx.beginPath();
  ctx.ellipse(area.x + area.w * 0.5, horizon + 2, area.w * 0.46, area.h * 0.035, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5ec98c';
  ctx.beginPath();
  ctx.ellipse(area.x + area.w * 0.5, horizon - 2, area.w * 0.4, area.h * 0.018, 0, 0, Math.PI * 2);
  ctx.fill();
  const fall = ctx.createLinearGradient(0, horizon, 0, horizon + area.h * 0.18);
  fall.addColorStop(0, 'rgba(210, 245, 255, 0.95)');
  fall.addColorStop(1, 'rgba(210, 245, 255, 0)');
  ctx.fillStyle = fall;
  ctx.fillRect(area.x + area.w * 0.32, horizon, area.w * 0.05, area.h * 0.18);
}

// ── Billboards and shared materials ──────────────────────────────────────────

/**
 * One billboard: a screen in world space. The city only builds the geometry;
 * ../ads/billboards.ts decides what it shows. The tower city has no
 * billboard slots yet, so none are built; the ad system stays wired for when
 * it does.
 */
export interface BillboardSlot {
  readonly plan: ScreenPlan;
  /** The screen surface. UVs run 0..1 across it, (0, 0) at the bottom left. */
  readonly geometry: BufferGeometry;
  /** The same shape floating slightly in front, for the empty-slot outline. */
  readonly overlay: BufferGeometry;
  /** Centre of the screen surface and the direction it faces. */
  readonly center: Vector3;
  readonly normal: Vector3;
}

export interface CityMaterials {
  glow: MeshBasicMaterial;
  citadelPoster: Poster;
  redraw(): void;
  dispose(): void;
}

/** The citadel's light trim and banner art, shared by every rebuild. */
export function createCityMaterials(anisotropy: number): CityMaterials {
  const citadelPoster = createPoster(CITADEL_POSTER, anisotropy);
  return {
    glow: new MeshBasicMaterial({ toneMapped: false, side: DoubleSide }),
    citadelPoster,
    redraw: () => citadelPoster.redraw(),
    dispose() {
      this.glow.dispose();
      citadelPoster.texture.dispose();
      citadelPoster.material.dispose();
    },
  };
}

export function applyCityTheme(materials: CityMaterials, light: boolean): void {
  materials.glow.color.set(light ? 0x3a3d44 : 0xffffff);
}

/**
 * Turn a cylinder inside out, so its faces point at the axis. The runtime
 * only blocks movement into the front of a face.
 */
export function flipInside(geometry: BufferGeometry): BufferGeometry {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
  }
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}

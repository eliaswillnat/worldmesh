import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The city around the citadel: white towers wearing big glowing screens, the
 * way a plaza looks from the citadel's gate. Everything is procedural and
 * seeded, so every visitor sees the same skyline.
 */

const SKY_RADIUS = 250;
/** Clear space between the citadel and the first ring of towers. */
const PLAZA_DEPTH = 22;
/** How far the second, taller ring stands behind the first. */
const BACK_RING_OFFSET = 34;

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

// ── Screens ──────────────────────────────────────────────────────────────────

type Art = 'planet' | 'skyline' | 'icons' | 'infinity' | 'hoodie' | 'figure';

interface PosterSpec {
  lines: string[];
  /** Which headline lines are drawn in the accent colour. */
  accent?: number[];
  sub?: string;
  art: Art;
  wide?: boolean;
}

/** The citadel's own banner, hung over the gate. */
export const CITADEL_POSTER: PosterSpec = {
  lines: ['EXPLORE', 'NEW', 'WORLDS'],
  accent: [1, 2],
  sub: 'IMMERSIVE 3D EXPERIENCES',
  art: 'planet',
};

const TALL_POSTERS: PosterSpec[] = [
  { lines: ['AURORA', 'WORLDS'], accent: [0, 1], sub: 'BEYOND REALITY', art: 'planet' },
  { lines: ['PLAY', 'EXPLORE', 'CREATE', 'TOGETHER'], art: 'skyline' },
  { lines: ['BUILD', 'CREATE', 'MONETIZE'], art: 'planet' },
  { lines: ['DISCOVER', 'PLAY', 'CREATE', 'BELONG'], art: 'skyline' },
  { lines: ['YOUR', 'AVATAR', 'YOUR', 'STORY'], sub: 'EXPRESS · CREATE · BELONG', art: 'figure' },
  { lines: ['3D ASSETS'], sub: 'FOR CREATORS', art: 'icons' },
  { lines: ['AVATARS', 'WORLDS', '3D ASSETS'], sub: 'CREATOR TOOLS', art: 'icons' },
  { lines: ['VIRTUAL', 'PRODUCTS'], sub: 'REAL IMPACT', art: 'hoodie' },
  { lines: ['NEXT GEN', 'CREATOR', 'TOOLS'], art: 'icons' },
];

const WIDE_POSTERS: PosterSpec[] = [
  { lines: ['INFINITE', 'WORLDS'], sub: 'REAL PEOPLE. EPIC EXPERIENCES.', art: 'infinity', wide: true },
  { lines: ['ONE PLATFORM.', 'ENDLESS POSSIBILITIES.'], sub: 'WORLDS   AVATARS   3D ASSETS   CREATOR TOOLS', art: 'skyline', wide: true },
];

const HEADLINE_FONT = 'Urbanist, "Arial Narrow", Arial, ui-sans-serif, system-ui, sans-serif';

export interface Poster {
  texture: CanvasTexture;
  material: MeshBasicMaterial;
  redraw(): void;
}

function createPoster(spec: PosterSpec, anisotropy: number): Poster {
  const canvas = document.createElement('canvas');
  canvas.width = spec.wide ? 1024 : 512;
  canvas.height = spec.wide ? 512 : 1024;
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

/** Small seeded generator so the art and the skyline are the same for everyone. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function drawPoster(ctx: CanvasRenderingContext2D, w: number, h: number, spec: PosterSpec): void {
  const rand = random(hash(spec.lines.join()));
  ctx.clearRect(0, 0, w, h);

  // Deep indigo at the top warming to violet and pink at the horizon.
  const bg = ctx.createLinearGradient(0, 0, spec.wide ? w * 0.3 : 0, h);
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

  // Art area: the lower part of a tall screen, the right part of a wide one.
  const art = spec.wide ? { x: w * 0.42, y: 0, w: w * 0.58, h } : { x: 0, y: h * 0.4, w, h: h * 0.6 };
  drawArt(ctx, art, spec.art, rand);

  // Headline.
  const pad = w * (spec.wide ? 0.05 : 0.09);
  const textWidth = (spec.wide ? w * 0.5 : w) - pad * 2;
  const base = spec.wide ? h * 0.2 : w * 0.2;
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
  let y = spec.wide ? h * 0.14 + size : h * 0.06 + size;
  if (spec.art === 'infinity') {
    drawInfinity(ctx, pad + size * 0.9, y - size * 0.35, size * 0.8);
    y += size * 1.1;
  }
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
    const words = spec.sub.split(' · ');
    y += subSize * 0.4;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    // Tall screens stack "A · B · C" as a list, like the reference signage.
    if (!spec.wide && words.length > 1) {
      for (const word of words) {
        ctx.fillText(word, pad, y);
        y += subSize * 1.15;
      }
    } else {
      ctx.fillText(spec.sub, pad, y);
      y += subSize * 1.15;
    }
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

/** The lemniscate, glowing cyan. */
function drawInfinity(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.strokeStyle = '#5ef2ff';
  ctx.lineWidth = s * 0.22;
  ctx.shadowColor = 'rgba(94, 242, 255, 0.9)';
  ctx.shadowBlur = s * 0.3;
  ctx.beginPath();
  for (let t = 0; t <= Math.PI * 2 + 0.05; t += 0.05) {
    const d = 1 + Math.sin(t) ** 2;
    const x = cx + (s * Math.cos(t)) / d;
    const y = cy + (s * Math.sin(t) * Math.cos(t)) / d;
    if (t === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawArt(ctx: CanvasRenderingContext2D, area: Rect, art: Art, rand: () => number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  const horizon = area.y + area.h * 0.72;

  if (art === 'planet' || art === 'skyline' || art === 'infinity') {
    // Sunset glow on the horizon.
    const glow = ctx.createRadialGradient(area.x + area.w * 0.5, horizon, 0, area.x + area.w * 0.5, horizon, area.w * 0.7);
    glow.addColorStop(0, 'rgba(255, 170, 230, 0.75)');
    glow.addColorStop(1, 'rgba(255, 170, 230, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(area.x, area.y, area.w, area.h);
  }

  if (art === 'planet' || art === 'infinity') {
    const r = Math.min(area.w, area.h) * (art === 'planet' ? 0.36 : 0.3);
    const cx = area.x + area.w * (art === 'planet' ? 0.62 : 0.72);
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
  }

  if (art === 'planet' || art === 'skyline' || art === 'infinity') {
    drawSkyline(ctx, area, horizon, rand);
  }

  if (art === 'icons') drawIcons(ctx, area);
  if (art === 'hoodie') drawHoodie(ctx, area);
  if (art === 'figure') drawFigure(ctx, area);

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

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Three app tiles: a cube, a shirt and a gamepad. */
function drawIcons(ctx: CanvasRenderingContext2D, area: Rect): void {
  const size = Math.min(area.w * 0.26, area.h * 0.3);
  const gap = size * 0.18;
  const total = size * 3 + gap * 2;
  const startX = area.x + (area.w - total) / 2;
  const y = area.y + area.h * 0.45 - size / 2;
  for (let i = 0; i < 3; i++) {
    const x = startX + i * (size + gap);
    const tile = ctx.createLinearGradient(x, y, x + size, y + size);
    tile.addColorStop(0, i === 0 ? '#3aa0ff' : i === 1 ? '#8a5cff' : '#c65cf0');
    tile.addColorStop(1, i === 0 ? '#5a6cff' : i === 1 ? '#b068ff' : '#e07df5');
    ctx.shadowColor = 'rgba(150, 200, 255, 0.8)';
    ctx.shadowBlur = size * 0.25;
    ctx.fillStyle = tile;
    roundedRect(ctx, x, y, size, size, size * 0.2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = size * 0.03;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = size * 0.07;
    ctx.lineJoin = 'round';
    const cx = x + size / 2;
    const cy = y + size / 2;
    const s = size * 0.26;
    ctx.beginPath();
    if (i === 0) {
      // Isometric cube.
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s * 0.9, cy - s * 0.5);
      ctx.lineTo(cx + s * 0.9, cy + s * 0.5);
      ctx.lineTo(cx, cy + s);
      ctx.lineTo(cx - s * 0.9, cy + s * 0.5);
      ctx.lineTo(cx - s * 0.9, cy - s * 0.5);
      ctx.closePath();
      ctx.moveTo(cx - s * 0.9, cy - s * 0.5);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + s * 0.9, cy - s * 0.5);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + s);
      ctx.stroke();
    } else if (i === 1) {
      // T-shirt.
      ctx.moveTo(cx - s * 0.35, cy - s);
      ctx.lineTo(cx - s * 1.1, cy - s * 0.6);
      ctx.lineTo(cx - s * 0.8, cy - s * 0.1);
      ctx.lineTo(cx - s * 0.55, cy - s * 0.25);
      ctx.lineTo(cx - s * 0.55, cy + s);
      ctx.lineTo(cx + s * 0.55, cy + s);
      ctx.lineTo(cx + s * 0.55, cy - s * 0.25);
      ctx.lineTo(cx + s * 0.8, cy - s * 0.1);
      ctx.lineTo(cx + s * 1.1, cy - s * 0.6);
      ctx.lineTo(cx + s * 0.35, cy - s);
      ctx.quadraticCurveTo(cx, cy - s * 0.6, cx - s * 0.35, cy - s);
      ctx.fill();
    } else {
      // Gamepad.
      roundedRect(ctx, cx - s * 1.1, cy - s * 0.55, s * 2.2, s * 1.1, s * 0.5);
      ctx.fill();
      ctx.fillStyle = tile;
      ctx.fillRect(cx - s * 0.75, cy - s * 0.06, s * 0.5, s * 0.12);
      ctx.fillRect(cx - s * 0.56, cy - s * 0.25, s * 0.12, s * 0.5);
      ctx.beginPath();
      ctx.arc(cx + s * 0.45, cy - s * 0.12, s * 0.1, 0, Math.PI * 2);
      ctx.arc(cx + s * 0.7, cy + s * 0.12, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A glowing hoodie on a hanger. */
function drawHoodie(ctx: CanvasRenderingContext2D, area: Rect): void {
  const cx = area.x + area.w * 0.5;
  const cy = area.y + area.h * 0.42;
  const s = area.w * 0.32;
  const cloth = ctx.createLinearGradient(cx - s, cy - s, cx + s, cy + s);
  cloth.addColorStop(0, '#d9c8ff');
  cloth.addColorStop(0.5, '#9f8cff');
  cloth.addColorStop(1, '#7ec8ff');
  ctx.shadowColor = 'rgba(200, 180, 255, 0.9)';
  ctx.shadowBlur = s * 0.3;
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.35, cy - s * 0.75);
  ctx.quadraticCurveTo(cx, cy - s * 1.2, cx + s * 0.35, cy - s * 0.75);
  ctx.lineTo(cx + s * 0.9, cy - s * 0.45);
  ctx.lineTo(cx + s * 1.05, cy + s * 0.75);
  ctx.lineTo(cx + s * 0.75, cy + s * 0.8);
  ctx.lineTo(cx + s * 0.6, cy - s * 0.05);
  ctx.lineTo(cx + s * 0.6, cy + s * 0.95);
  ctx.lineTo(cx - s * 0.6, cy + s * 0.95);
  ctx.lineTo(cx - s * 0.6, cy - s * 0.05);
  ctx.lineTo(cx - s * 0.75, cy + s * 0.8);
  ctx.lineTo(cx - s * 1.05, cy + s * 0.75);
  ctx.lineTo(cx - s * 0.9, cy - s * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(80, 50, 180, 0.5)';
  ctx.lineWidth = s * 0.03;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.55);
  ctx.lineTo(cx, cy + s * 0.95);
  ctx.moveTo(cx - s * 0.35, cy + s * 0.35);
  ctx.lineTo(cx + s * 0.35, cy + s * 0.35);
  ctx.stroke();
}

/** A stylised avatar portrait: glowing silhouette with long hair. */
function drawFigure(ctx: CanvasRenderingContext2D, area: Rect): void {
  const cx = area.x + area.w * 0.62;
  const top = area.y + area.h * 0.08;
  const s = area.w * 0.28;
  const hair = ctx.createLinearGradient(cx - s, top, cx + s, top + s * 3);
  hair.addColorStop(0, '#8fd8ff');
  hair.addColorStop(0.5, '#a58cff');
  hair.addColorStop(1, '#e28cff');
  ctx.shadowColor = 'rgba(170, 200, 255, 0.9)';
  ctx.shadowBlur = s * 0.3;
  // Hair behind.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.ellipse(cx, top + s * 0.9, s * 0.95, s * 0.95, 0, Math.PI, 0);
  ctx.lineTo(cx + s * 1.05, top + s * 2.9);
  ctx.lineTo(cx - s * 1.05, top + s * 2.9);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // Shoulders.
  ctx.fillStyle = '#2a2266';
  ctx.beginPath();
  ctx.moveTo(cx - s * 1.3, area.y + area.h);
  ctx.quadraticCurveTo(cx - s * 1.2, top + s * 2.2, cx, top + s * 2.15);
  ctx.quadraticCurveTo(cx + s * 1.2, top + s * 2.2, cx + s * 1.3, area.y + area.h);
  ctx.fill();
  // Neck and face.
  ctx.fillStyle = '#f4d9d0';
  ctx.fillRect(cx - s * 0.2, top + s * 1.5, s * 0.4, s * 0.7);
  ctx.beginPath();
  ctx.ellipse(cx, top + s * 1.05, s * 0.55, s * 0.68, 0, 0, Math.PI * 2);
  ctx.fill();
  // Fringe.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.ellipse(cx - s * 0.05, top + s * 0.62, s * 0.62, s * 0.36, -0.15, Math.PI, Math.PI * 2);
  ctx.fill();
  // Eyes.
  ctx.fillStyle = '#3b5bd6';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * s * 0.22, top + s * 1.05, s * 0.08, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Buildings ────────────────────────────────────────────────────────────────

export interface City {
  readonly group: Group;
  /** Invisible boxes around the reachable towers, plus the plaza's edge. */
  readonly colliders: Mesh[];
  /** Where the plaza ends: the ground only needs to reach this far. */
  readonly radius: number;
  /** Ground spot of the doorway built into the tower next to the gate, facing the citadel. */
  readonly entrance: { x: number; z: number };
  setTheme(light: boolean): void;
  dispose(): void;
}

export interface CityMaterials {
  building: MeshStandardMaterial;
  glow: MeshBasicMaterial;
  posters: Poster[];
  citadelPoster: Poster;
  redraw(): void;
  dispose(): void;
}

/** Materials and screen art shared by every rebuild of the city. */
export function createCityMaterials(anisotropy: number): CityMaterials {
  const posters = [...TALL_POSTERS, ...WIDE_POSTERS].map((spec) => createPoster(spec, anisotropy));
  const citadelPoster = createPoster(CITADEL_POSTER, anisotropy);
  const all = [...posters, citadelPoster];
  return {
    building: new MeshStandardMaterial({ roughness: 0.55, metalness: 0 }),
    glow: new MeshBasicMaterial({ toneMapped: false, side: DoubleSide }),
    posters,
    citadelPoster,
    redraw: () => all.forEach((poster) => poster.redraw()),
    dispose() {
      this.building.dispose();
      this.glow.dispose();
      for (const poster of all) {
        poster.texture.dispose();
        poster.material.dispose();
      }
    },
  };
}

export function applyCityTheme(materials: CityMaterials, light: boolean): void {
  // Bright white towers by day; dark monoliths with lit screens by night.
  materials.building.color.set(light ? 0xf5f6fa : 0x17171c);
  materials.building.emissive.set(light ? CITY_GLOW_WHITE : 0x000000);
  materials.glow.color.set(light ? 0x3a3d44 : 0xffffff);
}

/** Collects boxes and screens, then merges them into a handful of draw calls. */
class Builder {
  blocks: BufferGeometry[] = [];
  glow: BufferGeometry[] = [];
  screens = new Map<number, BufferGeometry[]>();
  colliders: Mesh[] = [];
  private matrix = new Matrix4();
  private frame: Matrix4;

  /** `frame` places the building being built; move it between buildings. */
  constructor(frame: Matrix4) {
    this.frame = frame;
  }

  /** A box in the building's local frame; (x, y, z) is its bottom centre. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, target: BufferGeometry[] = this.blocks): void {
    const geometry = new BoxGeometry(w, h, d).toNonIndexed();
    geometry.applyMatrix4(this.matrix.makeTranslation(x, y + h / 2, z).premultiply(this.frame));
    target.push(geometry);
  }

  cylinder(r: number, h: number, x: number, y: number, z: number): void {
    const geometry = new CylinderGeometry(r, r, h, 40).toNonIndexed();
    geometry.applyMatrix4(this.matrix.makeTranslation(x, y + h / 2, z).premultiply(this.frame));
    this.blocks.push(geometry);
  }

  /** A thin emissive ring, e.g. a light band around a round tower. */
  ring(r: number, y: number, x: number, z: number): void {
    const geometry = new CylinderGeometry(r, r, 0.07, 48, 1, true).toNonIndexed();
    geometry.applyMatrix4(this.matrix.makeTranslation(x, y, z).premultiply(this.frame));
    this.glow.push(geometry);
  }

  /** A flat screen facing local +z, centred at (x, y, z). */
  screen(poster: number, w: number, h: number, x: number, y: number, z: number): void {
    const geometry = new PlaneGeometry(w, h).toNonIndexed();
    geometry.applyMatrix4(this.matrix.makeTranslation(x, y, z).premultiply(this.frame));
    this.addScreen(poster, geometry);
  }

  /** A screen wrapped around a round tower, centred on local +z. */
  curvedScreen(poster: number, r: number, w: number, h: number, x: number, y: number, z: number): void {
    const theta = w / r;
    const geometry = new CylinderGeometry(r, r, h, 24, 1, true, -theta / 2, theta).toNonIndexed();
    geometry.applyMatrix4(this.matrix.makeTranslation(x, y, z).premultiply(this.frame));
    this.addScreen(poster, geometry);
  }

  /** An invisible box that stops the player, in the building's frame. */
  collider(w: number, h: number, d: number, x: number, z: number): void {
    const mesh = new Mesh(UNIT_BOX);
    mesh.visible = false;
    mesh.scale.set(w, h, d);
    mesh.position.set(x, h / 2, z);
    mesh.applyMatrix4(this.frame);
    this.colliders.push(mesh);
  }

  private addScreen(poster: number, geometry: BufferGeometry): void {
    const list = this.screens.get(poster) ?? [];
    list.push(geometry);
    this.screens.set(poster, list);
  }
}

const UNIT_BOX = new BoxGeometry(1, 1, 1);

/**
 * Lay out two rings of towers around a citadel whose outer wall is
 * `citadelRadius` wide. The gate faces +Z, so the first ring leaves the
 * avenue in front of it open and flanks it with the tallest screens.
 */
export function createCity(citadelRadius: number, materials: CityMaterials): City {
  const group = new Group();
  group.name = 'city';
  const rand = random(0x5eed);
  const wideStart = TALL_POSTERS.length;
  let nextTall = 0;
  let nextWide = 0;
  const tall = () => nextTall++ % TALL_POSTERS.length;
  const wide = () => wideStart + (nextWide++ % WIDE_POSTERS.length);

  const frame = new Matrix4();
  const builder = new Builder(frame);
  const front = citadelRadius + PLAZA_DEPTH;

  const entrance = { x: 0, z: 0 };
  const ring = (distance: number, spacing: number, scale: number, reachable: boolean) => {
    const count = Math.max(8, Math.round((Math.PI * 2 * distance) / spacing));
    for (let i = 0; i < count; i++) {
      // The first tower of the front ring, just beside the gate's view, gets a doorway.
      const doorway = reachable && i === 0;
      // Half a slot off so the gate (angle 0) looks down a gap between towers.
      const angle = ((i + 0.5) / count) * Math.PI * 2 + (rand() - 0.5) * 0.08;
      const depth = 7 + rand() * 3;
      const d = distance + depth / 2 + rand() * 3;
      // Local +Z faces the citadel.
      frame.makeRotationY(angle + Math.PI).setPosition(Math.sin(angle) * d, 0, Math.cos(angle) * d);
      if (rand() < 0.25 && !doorway) roundTower(builder, rand, scale, tall, reachable);
      else {
        const doorZ = blockTower(builder, rand, scale, depth, tall, wide, reachable, doorway);
        if (doorway) {
          const spot = new Vector3(0, 0, doorZ).applyMatrix4(frame);
          entrance.x = spot.x;
          entrance.z = spot.z;
        }
      }
    }
  };

  ring(front, 17, 1, true);
  ring(front + BACK_RING_OFFSET, 20, 1.7, false);

  const blocks = new Mesh(mergeGeometries(builder.blocks), materials.building);
  const glow = new Mesh(mergeGeometries(builder.glow), materials.glow);
  group.add(blocks, glow);
  for (const [poster, list] of builder.screens) {
    group.add(new Mesh(mergeGeometries(list), materials.posters[poster].material));
  }
  for (const geometry of [...builder.blocks, ...builder.glow, ...[...builder.screens.values()].flat()]) geometry.dispose();

  // An invisible fence just past the front of the first ring, so the plaza
  // has an edge between towers too.
  const radius = front + 4;
  const fence = new Mesh(new CylinderGeometry(radius, radius, 12, 64, 1, true));
  flipInside(fence.geometry);
  fence.visible = false;
  fence.position.y = 6;
  const colliders = [...builder.colliders, fence];
  group.add(...colliders);

  return {
    group,
    colliders,
    radius,
    entrance,
    setTheme: (light) => applyCityTheme(materials, light),
    dispose() {
      for (const child of group.children) {
        if (child instanceof Mesh && child.geometry !== UNIT_BOX) child.geometry.dispose();
      }
      group.removeFromParent();
    },
  };
}

/**
 * White stacked blocks: a main tower, a setback crown, a side wing and a low
 * plinth, lined with light strips and wearing one or two screens.
 */
function blockTower(
  b: Builder,
  rand: () => number,
  scale: number,
  depth: number,
  tall: () => number,
  wide: () => number,
  reachable: boolean,
  doorway = false,
): number {
  const w = 6 + rand() * 3;
  const h = (16 + rand() * 16) * scale;
  const d = depth;
  const strip = 0.07;

  // Plinth.
  b.box(w + 3, 0.7, d + 2, 0, 0, 0.4);
  // Main tower and crown.
  b.box(w, h, d, 0, 0, 0);
  const crownH = 3 + rand() * 6 * scale;
  b.box(w - 1.6, crownH, d - 1.6, 0, h, -0.3);
  b.box(w - 0.8, 0.5, d - 0.8, 0, h + crownH, -0.3);
  // Light strips up the front corners and along the top.
  for (const side of [-1, 1]) b.box(strip, h, strip, side * (w / 2 + 0.02), 0, d / 2 + 0.02, b.glow);
  b.box(w, strip, strip, 0, h - 0.4, d / 2 + 0.03, b.glow);
  // A vertical fin splitting the facade, like the reference towers.
  b.box(0.5, h * 0.9, 0.5, (rand() < 0.5 ? -1 : 1) * (w / 2 - 0.25), h * 0.05, d / 2 + 0.25);

  // Screen: tall, framed by a white bezel.
  const screenW = w - 1.8;
  // Leave room over the doorway's porch.
  const screenH = Math.min(screenW * 2, h - (doorway ? 7 : 5));
  const screenY = h - 2 - screenH / 2;
  b.box(screenW + 0.5, screenH + 0.5, 0.3, 0, screenY - screenH / 2 - 0.25, d / 2 + 0.1);
  b.screen(tall(), screenW, screenH, 0, screenY, d / 2 + 0.27);

  // Side wing with its own screen, low and forward.
  const side = rand() < 0.5 ? -1 : 1;
  const wingW = 3.5 + rand() * 2;
  const wingH = (9 + rand() * 8) * Math.min(scale, 1.3);
  const wingX = side * (w / 2 + wingW / 2 - 0.4);
  b.box(wingW, wingH, d - 1, wingX, 0, 1);
  b.box(strip, wingH, strip, wingX + side * (wingW / 2 + 0.02), 0, d / 2 + 0.52, b.glow);

  // A porch on the plinth: two cheeks and a canopy, open at the front where
  // the door stands. Returns how far out the door stands.
  const porchDepth = 2.6;
  const porchZ = d / 2 + porchDepth / 2;
  const doorZ = d / 2 + porchDepth - 0.2;
  if (doorway) {
    for (const cheek of [-1, 1]) {
      b.box(0.4, 3.3, porchDepth, cheek * 1.1, 0, porchZ);
      b.box(strip, 3.3, strip, cheek * 1.32, 0, d / 2 + porchDepth + 0.02, b.glow);
      if (reachable) b.collider(0.4, 3.3, porchDepth, cheek * 1.1, porchZ);
    }
    b.box(2.8, 0.45, porchDepth + 0.2, 0, 3.2, porchZ + 0.1);
    b.box(2.8, strip, strip, 0, 3.2, d / 2 + porchDepth + 0.22, b.glow);
  }

  // Low wide screen in front of the base on some towers (never over the porch).
  if (rand() < 0.45 && !doorway) {
    const lowW = w + wingW - 1.5;
    const lowH = lowW / 2;
    const lowX = wingX / 2;
    b.box(lowW + 0.8, lowH + 1.4, 1.2, lowX, 0, d / 2 + 1.2);
    b.screen(wide(), lowW, lowH, lowX, 0.8 + lowH / 2, d / 2 + 1.82);
    b.box(lowW + 0.8, strip, strip, lowX, lowH + 1.4, d / 2 + 1.82, b.glow);
    if (reachable) b.collider(lowW + 0.8, lowH + 2, 1.4, lowX, d / 2 + 1.2);
  } else if (wingH > 11) {
    const wingScreenW = wingW - 1;
    const wingScreenH = Math.min(wingScreenW * 2, wingH - 3);
    b.screen(tall(), wingScreenW, wingScreenH, wingX, wingH - 1.5 - wingScreenH / 2, d / 2 + 0.52);
  }

  if (reachable) {
    b.collider(w + 3, h, d + 2, 0, 0.4);
    b.collider(wingW, wingH, d - 1, wingX, 1);
  }
  return doorZ;
}

/** A white drum with a screen wrapped around its face and light rings. */
function roundTower(b: Builder, rand: () => number, scale: number, tall: () => number, reachable: boolean): void {
  const r = 4 + rand() * 1.5;
  const h = (20 + rand() * 14) * scale;
  b.box(r * 2 + 2.5, 0.7, r * 2 + 2.5, 0, 0, 0);
  b.cylinder(r, h, 0, 0, 0);
  b.cylinder(r + 0.3, 0.6, 0, h, 0);
  b.ring(r + 0.03, h - 0.5, 0, 0);
  b.ring(r + 0.03, 1.2, 0, 0);
  // Two screens stacked on the side facing the plaza.
  const screenW = r * 1.5;
  const screenH = screenW * 2;
  const upperY = h - 2 - screenH / 2;
  b.curvedScreen(tall(), r + 0.04, screenW, screenH, 0, upperY, 0);
  if (upperY - screenH > 2) b.curvedScreen(tall(), r + 0.04, screenW, screenH * 0.75, 0, upperY - screenH / 2 - 1 - screenH * 0.375, 0);
  if (reachable) b.collider(r * 2 + 2.5, h, r * 2 + 2.5, 0, 0);
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

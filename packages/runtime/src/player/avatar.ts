import {
  BufferAttribute,
  CanvasTexture,
  Group,
  LatheGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  type Material,
  RingGeometry,
  SphereGeometry,
  SplineCurve,
  SRGBColorSpace,
  Vector2,
  type BufferGeometry,
  type Object3D,
} from 'three';

/**
 * The default WorldMesh body: a small white figure with a big round head,
 * a drawn-on face, a pear-shaped body and stubby limbs. Every world gets the
 * same one until visitors bring their own, so it is deliberately plain.
 *
 * Built for a 1.8 m standing height with feet at y = 0, facing -Z (the
 * direction the camera looks at yaw 0). Scale the result for other heights.
 */

const RIG_KEY = 'worldmeshAvatarRig';

/** Faces the default figure can pull, in number-key order (1–9, then 0). */
export const AVATAR_EXPRESSIONS = [
  'smile',
  'grin',
  'laugh',
  'wink',
  'love',
  'surprised',
  'sad',
  'angry',
  'sleepy',
  'neutral',
] as const;

export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

/** The expression bound to a number key: 1 is the first, 0 the tenth. */
export function expressionForDigit(digit: number): AvatarExpression | null {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null;
  return AVATAR_EXPRESSIONS[(digit + 9) % 10];
}

export function isAvatarExpression(value: unknown): value is AvatarExpression {
  return typeof value === 'string' && (AVATAR_EXPRESSIONS as readonly string[]).includes(value);
}

interface AvatarRig {
  torso: Group;
  head: Group;
  face: MeshBasicMaterial;
  armL: Group;
  armR: Group;
  legL: Group;
  legR: Group;
  phase: number;
  stride: number;
  air: number;
  expression: AvatarExpression;
  blinking: boolean;
  /** Seconds until the next blink starts, or until the current one ends. */
  blinkTimer: number;
}

export interface AvatarMotion {
  dt: number;
  /** Horizontal speed in metres per second. */
  speed: number;
  grounded: boolean;
  /** Direction of travel as a yaw, used to turn the body in third person. */
  heading?: number;
}

/** A hard two-tone ramp. Only the darkest sliver is shadow, so the gray stays small. */
function toonSteps(shadow: string, light: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 8, 1);
  ctx.fillStyle = shadow;
  ctx.fillRect(0, 0, 2, 1);
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const APPEAR_KEY = 'worldmeshAppear';

/**
 * Warp the surface up and down and fade it in as `uFill` goes from 0 to 1.
 * Materials on one figure share a uniform so the body and face appear together.
 */
function attachAppear(material: Material, shared?: { value: number }): { value: number } {
  const fill = shared ?? { value: 1 };
  material.userData[APPEAR_KEY] = fill;
  material.customProgramCacheKey = () => 'worldmesh-appear';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFill = fill;
    const appearFns = `
varying vec3 vAppearPos;
uniform float uFill;
float appearHash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float appearNoise(vec3 p) {
  return appearHash(p) * 0.65 + appearHash(p * 2.7 + 4.2) * 0.35;
}`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${appearFns}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// Eased so the warp stays strong for longer before it settles.
float appearWarp = pow(1.0 - uFill, 0.6);
vec3 appearWorld = (modelMatrix * vec4(position, 1.0)).xyz;
float appearShift = (appearNoise(appearWorld * 5.5) * 2.0 - 1.0) * 1.1 * appearWarp;
transformed += (inverse(modelMatrix) * vec4(0.0, appearShift, 0.0, 0.0)).xyz;
vAppearPos = appearWorld;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${appearFns}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
// Fades from invisible to solid over the whole warp.
gl_FragColor.a *= uFill * uFill * (3.0 - 2.0 * uFill);`,
      );
  };
  return fill;
}

/** Tint a default avatar. Custom bodies are left alone. */
export function setAvatarColor(root: Object3D, color: string): boolean {
  let found = false;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!(material instanceof MeshToonMaterial)) continue;
      material.color.set(color);
      found = true;
    }
  });
  return found;
}

/** Drive the point-fill on a default avatar. Returns false for anything else. */
export function setAvatarAppear(root: Object3D, amount: number): boolean {
  let found = false;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const fill = material.userData[APPEAR_KEY] as { value: number } | undefined;
      if (!fill) continue;
      fill.value = amount;
      // Blend only while fading in, so a settled figure draws as before.
      // The face decal is always see-through; keep that.
      material.userData.appearTransparent ??= material.transparent;
      const blend = amount < 0.999 || material.userData.appearTransparent === true;
      if (material.transparent !== blend) {
        material.transparent = blend;
        material.needsUpdate = true;
      }
      found = true;
    }
  });
  return found;
}

const HEAD_RADIUS = 0.47;
const HEAD_Y = 1.33;
/** How far the arms hang away from the body at rest, in radians. */
const ARM_REST = 0.4;

export function createDefaultAvatar(height = 1.8): Group {
  const root = new Group();
  root.name = 'worldmesh:avatar';

  // Two flat tones: white in the light, light gray in the shade.
  const skin = new MeshToonMaterial({ color: 0xffffff, gradientMap: toonSteps('#d5d5d5', '#ffffff') });
  const skinFill = attachAppear(skin);
  const shaded = (geometry: BufferGeometry) => {
    const mesh = new Mesh(geometry, skin);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };

  // Everything above the legs bobs together while walking.
  const torso = new Group();
  root.add(torso);

  // One soft bean: shoulders tucked right under the head, rounding off, a
  // belly that is widest low down, and a rounded seat the legs grow out of.
  const body = shaded(lathe([
    [0, 1.1],
    [0.12, 1.08],
    [0.19, 1.02],
    [0.217, 0.93],
    [0.227, 0.8],
    [0.232, 0.56],
    [0.243, 0.44],
    [0.232, 0.36],
    [0.205, 0.29],
    [0.155, 0.24],
    [0.08, 0.214],
    [0, 0.208],
  ]));
  body.scale.z = 0.84;
  torso.add(body);

  const head = new Group();
  head.position.y = HEAD_Y;
  torso.add(head);
  head.add(shaded(new SphereGeometry(HEAD_RADIUS, 64, 48)));

  const faceMaterial = new MeshBasicMaterial({
    map: faceTexture('smile', false),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  attachAppear(faceMaterial, skinFill);
  const face = new Mesh(faceGeometry(), faceMaterial);
  face.name = 'worldmesh:avatar-face';
  // Built facing +Z; turn it to the front of the figure.
  face.rotation.y = Math.PI;
  head.add(face);

  // Limbs hang from pivots at the shoulders and hips so they can swing.
  const limb = (x: number, y: number, length: number, top: number, bottom: number, target: Object3D) => {
    const pivot = new Group();
    pivot.position.set(x, y, 0);
    pivot.add(shaded(taperedCapsule(length, top, bottom)));
    target.add(pivot);
    return pivot;
  };
  // Thick, soft arms whose round tops sink into the shoulders, so there is
  // no seam; hands swell slightly at the tips.
  const armL = limb(-0.182, 0.92, 0.52, 0.074, 0.08, torso);
  const armR = limb(0.182, 0.92, 0.52, 0.074, 0.08, torso);
  armL.rotation.z = -ARM_REST;
  armR.rotation.z = ARM_REST;
  // Stubby legs, wide where they leave the body and rounded at the feet.
  const legL = limb(-0.1, 0.34, 0.34, 0.088, 0.08, root);
  const legR = limb(0.1, 0.34, 0.34, 0.088, 0.08, root);

  const rig: AvatarRig = {
    torso,
    head,
    face: faceMaterial,
    armL,
    armR,
    legL,
    legR,
    phase: 0,
    stride: 0,
    air: 0,
    expression: 'smile',
    blinking: false,
    blinkTimer: nextBlink(),
  };
  root.userData[RIG_KEY] = rig;

  if (height !== 1.8) root.scale.setScalar(height / 1.8);
  return root;
}

/**
 * Change the face of an avatar made by `createDefaultAvatar`. Unknown names
 * and custom avatars are ignored.
 */
export function setAvatarExpression(avatar: Object3D, expression: string): void {
  const rig = avatar.userData[RIG_KEY] as AvatarRig | undefined;
  if (!rig || !isAvatarExpression(expression) || rig.expression === expression) return;
  rig.expression = expression;
  rig.face.map = faceTexture(expression, rig.blinking);
}

export function getAvatarExpression(avatar: Object3D): AvatarExpression | null {
  const rig = avatar.userData[RIG_KEY] as AvatarRig | undefined;
  return rig ? rig.expression : null;
}

/**
 * Swing the limbs of an avatar made by `createDefaultAvatar`. Call once per
 * frame with how fast it is moving; anything else is ignored, so it is safe
 * to call on custom avatars too. Returns true on the frame a foot lands,
 * false otherwise, and null when `avatar` is not a default avatar.
 */
export function animateDefaultAvatar(avatar: Object3D, motion: AvatarMotion): boolean | null {
  const rig = avatar.userData[RIG_KEY] as AvatarRig | undefined;
  if (!rig) return null;
  if (motion.dt <= 0) return false;

  const blend = 1 - Math.exp(-motion.dt * 10);
  const walking = motion.grounded ? MathUtils.clamp(motion.speed / 4.5, 0, 1) : 0;
  rig.stride += (walking - rig.stride) * blend;
  rig.air += ((motion.grounded ? 0 : 1) - rig.air) * blend;

  // Steps get longer, not just faster, as speed rises.
  const before = footfalls(rig.phase);
  rig.phase += motion.dt * (4 + motion.speed * 1.2) * (rig.stride > 0.01 ? 1 : 0);
  const swing = Math.sin(rig.phase) * 0.75 * rig.stride;

  rig.legL.rotation.x = swing + rig.air * 0.35;
  rig.legR.rotation.x = -swing - rig.air * 0.15;
  rig.armL.rotation.x = -swing * 0.8;
  rig.armR.rotation.x = swing * 0.8;
  rig.armL.rotation.z = -ARM_REST - rig.air * 0.6;
  rig.armR.rotation.z = ARM_REST + rig.air * 0.6;

  rig.torso.position.y = Math.abs(Math.cos(rig.phase)) * 0.045 * rig.stride;
  rig.head.rotation.z = Math.sin(rig.phase) * 0.04 * rig.stride;
  // A foot lands where the legs are furthest apart and the body is lowest.
  const landed = motion.grounded && rig.stride > 0.15 && footfalls(rig.phase) !== before;

  rig.blinkTimer -= motion.dt;
  if (rig.blinkTimer <= 0) {
    rig.blinking = !rig.blinking;
    rig.blinkTimer = rig.blinking ? 0.12 : nextBlink();
    rig.face.map = faceTexture(rig.expression, rig.blinking);
  }
  return landed;
}

/** How many footfalls a walk cycle at `phase` has passed: one per half turn, offset to the widest stance. */
function footfalls(phase: number): number {
  return Math.floor((phase - Math.PI / 2) / Math.PI);
}

function nextBlink(): number {
  return 2.5 + Math.random() * 3.5;
}

// --- Geometry ---------------------------------------------------------------

/** A smooth solid of revolution through (radius, y) points, top to bottom. */
function lathe(profile: [number, number][]): LatheGeometry {
  const curve = new SplineCurve(profile.map(([r, y]) => new Vector2(r, y)));
  // Lathe wants the profile bottom to top so the faces point outward.
  const points = curve.getSpacedPoints(96).reverse();
  points[0].x = 0;
  points[points.length - 1].x = 0;
  return new LatheGeometry(points, 64);
}

/** A capsule hanging down from its top, `top` wide at the pivot and `bottom` wide at the tip. */
function taperedCapsule(length: number, top: number, bottom: number): LatheGeometry {
  const points: Vector2[] = [];
  const steps = 16;
  // Bottom cap, then the straight taper, then the top cap.
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    points.push(new Vector2(Math.cos(a) * bottom, -length + bottom + Math.sin(a) * bottom));
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    points.push(new Vector2(Math.cos(a) * top, -top + Math.sin(a) * top));
  }
  points[0].x = 0;
  points[points.length - 1].x = 0;
  return new LatheGeometry(points, 40);
}

/** Half the width of the square the face is drawn in, in metres on the head. */
const FACE_EXTENT = 0.4;

/**
 * A disc wrapped onto the front of the head. Its UVs are a straight front-on
 * projection, so whatever is drawn on the face canvas looks exactly like that
 * when the figure faces the camera.
 */
function faceGeometry(): RingGeometry {
  const geometry = new RingGeometry(0.001, FACE_EXTENT - 0.02, 64, 24);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const normals = new Float32Array(position.count * 3);
  const radius = HEAD_RADIUS * 1.004;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = Math.sqrt(Math.max(0, radius * radius - x * x - y * y));
    position.setZ(i, z);
    normals.set([x / radius, y / radius, z / radius], i * 3);
  }
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (position.getX(i) + FACE_EXTENT) / (2 * FACE_EXTENT), (position.getY(i) + FACE_EXTENT) / (2 * FACE_EXTENT));
  }
  return geometry;
}

// --- Faces ------------------------------------------------------------------

const FACE_SIZE = 512;
const INK = '#111114';
const EYE_X = 0.22;
const EYE_Y = -0.055;
const EYE_R = 0.05;
const LINE = 0.014;
/** How big the features are drawn, relative to the layout below. */
const FACE_SCALE = 0.78;
/** The point between the eyes and the mouth the features shrink toward. */
const FACE_CENTER_Y = -0.13;

/** Every avatar shares one texture per face, so a crowd costs no more than one visitor. */
const faceCache = new Map<string, CanvasTexture>();

function faceTexture(expression: AvatarExpression, blinking: boolean): CanvasTexture {
  const key = `${expression}${blinking ? ':blink' : ''}`;
  let texture = faceCache.get(key);
  if (texture) return texture;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = FACE_SIZE;
  const ctx = canvas.getContext('2d')!;
  // Draw in metres on the head, y up, origin at the head centre.
  const scale = FACE_SIZE / (2 * FACE_EXTENT);
  ctx.setTransform(scale, 0, 0, -scale, FACE_SIZE / 2, FACE_SIZE / 2);
  // Shrink the features around the middle of the face, not the head centre,
  // so the face gets smaller without sliding up the head.
  ctx.translate(0, FACE_CENTER_Y);
  ctx.scale(FACE_SCALE, FACE_SCALE);
  ctx.translate(0, -FACE_CENTER_Y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawFace(ctx, expression, blinking);

  texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  faceCache.set(key, texture);
  return texture;
}

type Ctx = CanvasRenderingContext2D;

function drawFace(ctx: Ctx, expression: AvatarExpression, blinking: boolean): void {
  const eyes = (radius = EYE_R) => {
    for (const side of [-1, 1]) {
      if (blinking) closedEye(ctx, side * EYE_X, EYE_Y, 'flat');
      else dotEye(ctx, side * EYE_X, EYE_Y, radius);
    }
  };

  switch (expression) {
    case 'smile':
      eyes();
      smile(ctx, 0.084, -0.127, -0.235);
      break;
    case 'grin':
      eyes();
      openMouth(ctx, 0.11, -0.115, -0.285);
      break;
    case 'laugh':
      for (const side of [-1, 1]) closedEye(ctx, side * EYE_X, EYE_Y, 'happy');
      openMouth(ctx, 0.125, -0.105, -0.31);
      break;
    case 'wink':
      // The figure's right eye (the viewer's left) stays open.
      if (blinking) closedEye(ctx, -EYE_X, EYE_Y, 'flat');
      else dotEye(ctx, -EYE_X, EYE_Y, EYE_R);
      closedEye(ctx, EYE_X, EYE_Y, 'happy');
      smile(ctx, 0.084, -0.127, -0.235);
      break;
    case 'love':
      for (const side of [-1, 1]) heart(ctx, side * EYE_X, EYE_Y, 0.092);
      smile(ctx, 0.084, -0.127, -0.235);
      break;
    case 'surprised':
      eyes(EYE_R * 1.2);
      for (const side of [-1, 1]) brow(ctx, side, 0.05, 0.05, 0.035);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.ellipse(0, -0.175, 0.04, 0.052, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'sad':
      eyes();
      for (const side of [-1, 1]) brow(ctx, side, 0.06, -0.035);
      smile(ctx, 0.07, -0.19, -0.1);
      tear(ctx, EYE_X + 0.01, EYE_Y - 0.085);
      break;
    case 'angry':
      eyes();
      for (const side of [-1, 1]) brow(ctx, side, -0.015, 0.05);
      smile(ctx, 0.075, -0.18, -0.115);
      break;
    case 'sleepy':
      for (const side of [-1, 1]) closedEye(ctx, side * EYE_X, EYE_Y, 'sleep');
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.ellipse(0, -0.17, 0.022, 0.028, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'neutral':
      eyes();
      line(ctx, [[-0.065, -0.155], [0.065, -0.155]]);
      break;
  }
}

function dotEye(ctx: Ctx, x: number, y: number, radius: number): void {
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x - radius * 0.5, y + radius * 0.46, radius * 0.26, 0, Math.PI * 2);
  ctx.fill();
}

/** `happy` is an upturned ^, `sleep` a relaxed downturned curve, `flat` a blink. */
function closedEye(ctx: Ctx, x: number, y: number, shape: 'happy' | 'sleep' | 'flat'): void {
  const w = EYE_R * 1.15;
  const bend = shape === 'happy' ? 0.07 : shape === 'sleep' ? -0.04 : 0;
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE * 1.15;
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.quadraticCurveTo(x, y + bend, x + w, y);
  ctx.stroke();
}

/** A curve from (±halfWidth, endY) through a control point at controlY: below the ends smiles, above frowns. */
function smile(ctx: Ctx, halfWidth: number, endY: number, controlY: number): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE;
  // A soft U rather than a V: both handles pulled in from the corners and
  // only half as deep, so the bottom is round and flat-ish and the corners
  // rise gently.
  const handleY = endY + (controlY - endY) * 0.52;
  ctx.beginPath();
  ctx.moveTo(-halfWidth, endY);
  ctx.bezierCurveTo(-halfWidth * 0.5, handleY, halfWidth * 0.5, handleY, halfWidth, endY);
  ctx.stroke();
}

/** A D-shaped open mouth with a tongue. */
function openMouth(ctx: Ctx, halfWidth: number, topY: number, controlY: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-halfWidth, topY);
  ctx.quadraticCurveTo(0, controlY, halfWidth, topY);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.clip();
  const bottom = (topY + controlY) / 2;
  ctx.fillStyle = '#ff7b8c';
  ctx.beginPath();
  ctx.ellipse(0, bottom - 0.005, halfWidth * 0.55, 0.045, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A brow over one eye. `inner` and `outer` are heights above the eye top, so they set the slant; `arch` bows it upward. */
function brow(ctx: Ctx, side: number, inner: number, outer: number, arch = 0): void {
  const x = side * EYE_X;
  const base = EYE_Y + EYE_R + 0.03;
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE;
  ctx.beginPath();
  ctx.moveTo(x - side * 0.05, base + inner);
  ctx.quadraticCurveTo(x, base + (inner + outer) / 2 + arch * 2, x + side * 0.05, base + outer);
  ctx.stroke();
}

function heart(ctx: Ctx, x: number, y: number, size: number): void {
  ctx.fillStyle = '#ff4d6d';
  ctx.beginPath();
  ctx.moveTo(x, y - size * 0.75);
  ctx.bezierCurveTo(x - size * 1.1, y - size * 0.05, x - size * 0.7, y + size * 0.85, x, y + size * 0.35);
  ctx.bezierCurveTo(x + size * 0.7, y + size * 0.85, x + size * 1.1, y - size * 0.05, x, y - size * 0.75);
  ctx.fill();
}

function tear(ctx: Ctx, x: number, y: number): void {
  ctx.fillStyle = '#6cc4ff';
  ctx.beginPath();
  ctx.moveTo(x, y + 0.04);
  ctx.quadraticCurveTo(x + 0.028, y - 0.002, x + 0.02, y - 0.016);
  ctx.arc(x, y - 0.016, 0.02, 0, Math.PI, true);
  ctx.quadraticCurveTo(x - 0.028, y - 0.002, x, y + 0.04);
  ctx.fill();
}

function line(ctx: Ctx, points: [number, number][]): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
}

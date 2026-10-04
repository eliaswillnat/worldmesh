import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  TorusGeometry,
  Vector3,
  type Texture,
} from 'three';
import type { ScreenPlan } from './layout';

/**
 * What the citadel and the city around it share: the sky dome, the banners
 * over the gates and inside the hall, the light trim, and the billboard slot
 * type the ad system draws on. The city itself (the category towers) lives
 * in ../towers.
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
  uniform float uCurve;
  varying vec3 vDirection;
  void main() {
    float h = clamp(normalize(vDirection).y, 0.0, 1.0);
    // Light: pale at the horizon, a clean saturated blue overhead.
    // Dark: a faint grey at the horizon, deepening to black overhead.
    vec3 color = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.75, h), uCurve));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Emissive lift for white surfaces in daylight, so their shaded sides stay white. */
export const CITY_GLOW_WHITE = 0x6b707c;

export const SKY_TOP = 0x2f80ea;
export const SKY_HORIZON = 0xc4defb;
export const SKY_TOP_DARK = 0x000000;
export const SKY_HORIZON_DARK = 0x222429;

/** A plain gradient dome. Move it with the player so it never gets closer. */
export function createSky(): Mesh<SphereGeometry, ShaderMaterial> {
  const sky = new Mesh(
    new SphereGeometry(SKY_RADIUS, 32, 16),
    new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uTop: { value: new Color(SKY_TOP) },
        uHorizon: { value: new Color(SKY_HORIZON) },
        uCurve: { value: 0.55 },
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

/** The horizon colour the fog and the scene background must match. */
export function skyHorizon(light: boolean): number {
  return light ? SKY_HORIZON : SKY_HORIZON_DARK;
}

export function applySkyTheme(sky: Mesh<SphereGeometry, ShaderMaterial>, light: boolean): void {
  const { uniforms } = sky.material;
  uniforms.uTop.value.set(light ? SKY_TOP : SKY_TOP_DARK);
  uniforms.uHorizon.value.set(skyHorizon(light));
  // The dark sky darkens more gradually, so the grey reads as a glow along the horizon.
  uniforms.uCurve.value = light ? 0.55 : 0.8;
}

/**
 * Paper Design god-rays (Apache-2.0): a noisy shaft along local Y. Spawn uses a
 * tall vertical volume; doors use a short one rotated to spill into the hall.
 */
export function createGodRayMaterial(options: {
  length: number;
  gain: number;
  time: { value: number };
  theme: { value: number };
  presence: { value: number };
  tint?: Color;
  /** Rectangular shaft in local XYZ (X/Y the opening, Z the spill). Omit for a vertical column. */
  square?: { width: number; height: number };
}): ShaderMaterial {
  const height = options.length.toFixed(1);
  const tint = options.tint ?? new Color(1, 1, 1);
  const square = options.square;
  const halfW = ((square?.width ?? 1) / 2).toFixed(4);
  const halfH = ((square?.height ?? 1) / 2).toFixed(4);
  const squareMain = /* glsl */ `
        vec2 p = vec2(vLocal.x / ${halfW}, vLocal.y / ${halfH});
        float along = clamp(vLocal.z / ${height} + 0.5, 0.0, 1.0);
        float t = 0.2 * uTime * 4.5;
        vec2 warp = vec2(
          valueNoise(vec2(p.x * 2.2 + t * 0.85, p.y * 1.6 - t * 0.4)) - 0.5,
          valueNoise(vec2(p.y * 2.0 + t * 0.55, along * 3.4 + t * 0.7)) - 0.5
        );
        vec2 warpFine = vec2(
          valueNoise(vec2(p.x * 5.5 - t * 1.1, along * 6.0 + t)) - 0.5,
          valueNoise(vec2(p.y * 5.0 + t * 0.9, p.x * 4.2 - along * 2.0)) - 0.5
        );
        float warpAmt = mix(0.04, 0.28, along * along);
        vec2 shapeUV = p + warp * warpAmt * 2.0 + warpFine * warpAmt * 0.7;
        float rayIntensity = 2.05;
        float middleShape = pow(1.0 - along, 3.0) * 0.32;

        vec3 accumColor = vec3(0.0);
        float accumAlpha = 0.0;
        vec3 tint0 = uTint;
        vec3 tint1 = uTint * vec3(0.92, 0.96, 1.05);
        vec3 tint2 = uTint * vec3(1.06, 0.97, 0.88);
        vec3 tint3 = uTint * 0.78;
        float tintA0 = 0.9;
        float tintA1 = 0.75;
        float tintA2 = 1.0;
        float tintA3 = 0.7;
        for (int i = 0; i < 4; i++) {
          vec3 rayTint = i == 0 ? tint0 : i == 1 ? tint1 : i == 2 ? tint2 : tint3;
          float tintA = i == 0 ? tintA0 : i == 1 ? tintA1 : i == 2 ? tintA2 : tintA3;
          float r1 = along * (1.0 + 0.4 * float(i)) - 3.0 * t;
          float r2 = 0.5 * along - 2.0 * t;
          float density = 8.0 * 0.45;
          float f = mix(1.4, 3.6 + 0.6 * float(i), hash11(float(i) * 15.0)) * density;
          vec2 shifted = shapeUV + vec2(hash11(float(i) * 3.1) - 0.5, hash11(float(i) * 7.7) - 0.5) * 0.12;
          float ray = raysShapeSquare(shifted, r1, 5.0 * f, rayIntensity);
          ray *= mix(0.5, 1.0, raysShapeSquare(shifted, r2, 3.6 * f, rayIntensity));
          ray += (0.35 + 1.2 * ray) * middleShape;
          ray = clamp(ray, 0.0, 1.0);
          float srcAlpha = tintA * ray;
          vec3 srcColor = rayTint * srcAlpha;
          float bloom = 0.4;
          vec3 alphaBlendColor = accumColor + (1.0 - accumAlpha) * srcColor;
          float alphaBlendAlpha = accumAlpha + (1.0 - accumAlpha) * srcAlpha;
          accumColor = mix(alphaBlendColor, accumColor + srcColor, bloom);
          accumAlpha = mix(alphaBlendAlpha, accumAlpha + srcAlpha, bloom);
        }
        vec3 bloomTint = uTint;
        accumColor = mix(accumColor, accumColor + accumAlpha * bloomTint, 0.25);

        float fall = (1.0 - along) * (1.0 - along);
        float mouth = smoothstep(0.0, 0.06, along);
        float intensity = accumAlpha * fall * mouth * uGain * uPresence * mix(0.9, 0.5, uLight);
        vec3 color = uTint * intensity;
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
  `;
  const columnMain = /* glsl */ `
        vec3 axis = normalize(vec3(vLocal.x, 0.0, vLocal.z));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float ndot = abs(dot(axis, viewDir));
        float facing = smoothstep(0.0, 0.78, ndot);
        facing *= facing;
        float height = ${height};
        float down = 1.0 - clamp(vLocal.y / height + 0.5, 0.0, 1.0);
        float ang = atan(vLocal.x, vLocal.z);
        vec2 shapeUV = vec2(ang / PI * 0.42, down * 1.35 - 0.15);

        float t = 0.2 * uTime * 4.5;
        float radius = length(shapeUV);
        float spots = 6.5 * 0.3;
        float rayIntensity = 4.0 - 3.0 * 0.8;
        float midSize = 10.0 * 0.2;
        float middleShape = pow(0.4, 0.3) * (1.0 - smoothstep(0.02 * midSize, max(midSize, 0.000001), 3.0 * radius));
        middleShape = pow(middleShape, 5.0);

        vec3 accumColor = vec3(0.0);
        float accumAlpha = 0.0;
        vec3 tint0 = vec3(1.0, 1.0, 1.0);
        vec3 tint1 = vec3(0.9, 0.95, 1.0);
        vec3 tint2 = vec3(1.0, 0.98, 0.94);
        vec3 tint3 = vec3(0.85, 0.96, 1.0);
        float tintA0 = 0.9;
        float tintA1 = 0.75;
        float tintA2 = 1.0;
        float tintA3 = 0.7;
        for (int i = 0; i < 4; i++) {
          vec3 rayTint = i == 0 ? tint0 : i == 1 ? tint1 : i == 2 ? tint2 : tint3;
          float tintA = i == 0 ? tintA0 : i == 1 ? tintA1 : i == 2 ? tintA2 : tintA3;
          vec2 rotatedUV = rotate(shapeUV, float(i) + 1.0);
          float r1 = radius * (1.0 + 0.4 * float(i)) - 3.0 * t;
          float r2 = 0.5 * radius * (1.0 + spots) - 2.0 * t;
          float density = 6.0 * 0.3;
          float f = mix(1.0, 3.0 + 0.5 * float(i), hash11(float(i) * 15.0)) * density;
          float ray = raysShape(rotatedUV, r1, 5.0 * f, rayIntensity);
          ray *= raysShape(rotatedUV, r2, 4.0 * f, rayIntensity);
          ray += (1.0 + 4.0 * ray) * middleShape;
          ray = clamp(ray, 0.0, 1.0);
          float srcAlpha = tintA * ray;
          vec3 srcColor = rayTint * srcAlpha;
          float bloom = 0.4;
          vec3 alphaBlendColor = accumColor + (1.0 - accumAlpha) * srcColor;
          float alphaBlendAlpha = accumAlpha + (1.0 - accumAlpha) * srcAlpha;
          accumColor = mix(alphaBlendColor, accumColor + srcColor, bloom);
          accumAlpha = mix(alphaBlendAlpha, accumAlpha + srcAlpha, bloom);
        }
        vec3 bloomTint = vec3(0.75, 0.82, 1.0);
        accumColor = mix(accumColor, accumColor + accumAlpha * bloomTint, 0.4);

        float y01 = clamp(vLocal.y / height + 0.5, 0.0, 1.0);
        float base = pow(smoothstep(0.08, 0.65, y01 * height), 2.2);
        float tip = 1.0 - smoothstep(0.62, 1.0, y01);
        // Seen from inside (first person, or a camera swung in close) the
        // tube would cover the whole view and wash the walls and doors out:
        // fade it away as the camera nears the beam's axis.
        float fromAxis = length(cameraPosition.xz - vAxis);
        float outside = smoothstep(1.6, 3.2, fromAxis);
        float alpha = facing * accumAlpha * base * tip * uGain * uPresence * outside * mix(1.0, 0.55, uLight);
        vec3 color = accumColor * mix(vec3(6.0), vec3(4.2, 4.0, 3.6), uLight) * uTint;
        float ca = 0.045 * sin(ang * 2.0 + uTime * 0.15);
        color.r *= 1.0 + ca;
        color.b *= 1.0 - ca;
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
  `;
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: !square,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: false,
    uniforms: {
      uTime: options.time,
      uLight: options.theme,
      uGain: { value: options.gain },
      uPresence: options.presence,
      uTint: { value: tint },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vViewLocal;
      varying vec2 vAxis;
      void main() {
        vLocal = position;
        vAxis = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec3 worldView = cameraPosition - world.xyz;
        vec3 vx = normalize(modelMatrix[0].xyz);
        vec3 vy = normalize(modelMatrix[1].xyz);
        vec3 vz = normalize(modelMatrix[2].xyz);
        vViewLocal = vec3(dot(worldView, vx), dot(worldView, vy), dot(worldView, vz));
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLight;
      uniform float uGain;
      uniform float uPresence;
      uniform vec3 uTint;
      #define TWO_PI 6.28318530718
      #define PI 3.14159265359
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vViewLocal;
      varying vec2 vAxis;

      vec2 rotate(vec2 uv, float th) {
        return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
      }
      float hash11(float p) {
        p = fract(p * 0.3183099) + 0.1;
        p *= p + 19.19;
        return fract(p * p);
      }
      float hash21(vec2 p) {
        p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float valueNoise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      float raysShape(vec2 uv, float r, float freq, float intensity) {
        float a = atan(uv.y, uv.x);
        vec2 left = vec2(a * freq, r);
        vec2 right = vec2(fract(a / TWO_PI) * TWO_PI * freq, r);
        float nLeft = pow(valueNoise(left), intensity);
        float nRight = pow(valueNoise(right), intensity);
        return mix(nRight, nLeft, smoothstep(-0.15, 0.15, uv.x));
      }
      float raysShapeSquare(vec2 uv, float r, float freq, float intensity) {
        float nx = pow(valueNoise(vec2(uv.x * freq, r)), intensity);
        float ny = pow(valueNoise(vec2(uv.y * freq * 0.8, r * 1.2)), intensity);
        float holes = pow(valueNoise(vec2(uv.x * freq * 1.7 + r * 0.55, uv.y * freq * 1.5 - r)), intensity + 0.7);
        return nx * ny * mix(0.22, 1.0, holes);
      }

      void main() {
        if (uPresence < 0.001) discard;
        ${square ? squareMain : columnMain}
      }
    `,
  });
}

/** Metres climbed: slow for 2s, then speed eases up over the next 4s. */
function pulseClimb(age: number): number {
  const slow = 1.6;
  const fast = 92;
  const hold = 2;
  const ramp = 4;
  if (age <= 0) return 0;
  if (age <= hold) return slow * age;
  const s = Math.min(1, (age - hold) / ramp);
  const duringRamp = (fast - slow) * ramp * (s ** 3 - 0.5 * s ** 4);
  if (s < 1) return slow * age + duringRamp;
  return slow * age + (fast - slow) * (ramp * 0.5 + (age - hold - ramp));
}

/**
 * The dressing on the spawn dais: a third, wider step, an animated dial
 * inlaid in the top (tick marks, rings, turning arcs, a sweeping scan), two
 * open rings of light turning in the outer step, a ring of lit dashes in it with a light
 * running round them, and a soft glow on the floor. It all brightens while
 * the beam is lit.
 */
/** Heights of the spawn dais's tiers: the outer step, the base, and the top the dial is in. */
const DAIS_STEP = 0.02;
const DAIS_BASE = 0.03;
const DAIS_TOP = 0.04;

function createDaisDressing(
  time: { value: number },
  presence: { value: number },
  deckMaterial: MeshStandardMaterial,
): { group: Group; step: Mesh; update(now: number): void; setTheme(light: boolean): void; dispose(): void } {
  const group = new Group();
  group.name = 'spawn-dais';
  const light = { value: 0 };
  // The beam's brightness, eased, so the dais rises and settles gently with it.
  const boost = { value: 0 };
  let last = Number.NaN;
  const geometries: BufferGeometry[] = [];
  const materials: Array<{ dispose(): void }> = [];
  const keep = <T extends BufferGeometry>(geometry: T) => (geometries.push(geometry), geometry);

  // The outer step, under the dais's own two.
  const step = new Mesh(keep(new CylinderGeometry(2.7, 2.85, DAIS_STEP, 96)), deckMaterial);
  step.position.y = DAIS_STEP / 2;
  group.add(step);

  const glowColor = new Color();
  const glow = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false });
  materials.push(glow);
  const stepRim = new Mesh(keep(new TorusGeometry(2.85, 0.01, 8, 128)), glow);
  stepRim.rotation.x = Math.PI / 2;
  stepRim.position.y = 0.012;
  group.add(stepRim);

  // The dial inlaid in the top.
  const dialRadius = 1.55;
  const dial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: { uTime: time, uBoost: boost, uLight: light, uRadius: { value: dialRadius } },
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBoost;
      uniform float uLight;
      uniform float uRadius;
      varying vec2 vPos;

      float ring(float r, float at, float width) {
        float aa = fwidth(r) * 1.5;
        return 1.0 - smoothstep(width, width + aa, abs(r - at));
      }
      float band(float r, float a, float b) {
        float aa = fwidth(r);
        return smoothstep(a - aa, a + aa, r) * (1.0 - smoothstep(b - aa, b + aa, r));
      }
      // Distance to the nearest of \`count\` evenly spaced spokes, as a 0–1 line.
      float spokes(float angle, float count, float width) {
        float t = angle / 6.2831853 * count;
        float t2 = (angle + 3.14159265) / 6.2831853 * count;
        float w = min(fwidth(t), fwidth(t2));
        float d = abs(fract(t + 0.5) - 0.5);
        return 1.0 - smoothstep(width, width + w * 1.5, d);
      }

      ${SRGB_DECODE}
      void main() {
        float r = length(vPos);
        float a = atan(vPos.y, vPos.x);
        float boost = uBoost;

        float lines = ring(r, 1.47, 0.012) + ring(r, 1.08, 0.007) * 0.7 + ring(r, 0.64, 0.007) * 0.6 + ring(r, 0.22, 0.01) * 0.8;
        // A bezel of tick marks, a long one every sixth.
        lines += spokes(a, 72.0, 0.07) * band(r, 1.22, 1.38) * 0.7;
        lines += spokes(a, 12.0, 0.04) * band(r, 1.14, 1.42);
        // Arcs turning either way.
        float arcsA = step(fract((a + uTime * 0.35) / 6.2831853 * 3.0), 0.62) * band(r, 0.8, 0.9);
        float arcsB = step(fract((a - uTime * 0.6) / 6.2831853 * 5.0), 0.45) * band(r, 0.4, 0.47);
        lines += arcsA * 0.75 + arcsB * 0.6;
        // A scan sweeping round, and ripples running out while the beam is lit.
        float sweep = pow(max(0.0, cos(a - uTime * 1.3)), 18.0) * band(r, 0.25, 1.45) * 0.35;
        float ripple = pow(0.5 + 0.5 * sin((r - uTime * 2.2) * 9.0), 6.0) * band(r, 0.25, 1.45) * boost * 0.25;
        float core = exp(-r * r * 9.0) * (0.25 + boost * 0.3);
        float edgeFade = 1.0 - smoothstep(uRadius - 0.04, uRadius, r);
        float amount = (lines * (0.6 + 0.15 * boost) + sweep + ripple + core) * edgeFade;

        vec3 glow = vec3(1.0);
        vec3 ink = vec3(0.16, 0.16, 0.18);
        if (uLight > 0.5) {
          gl_FragColor = vec4(ink, clamp(amount, 0.0, 1.0) * 0.75);
        } else {
          gl_FragColor = vec4(glow * amount * 1.3, clamp(amount, 0.0, 1.0));
        }

        // Same on screen as through the beam's pass: decode, then let three encode for wherever this draws.
        gl_FragColor = srgbDecode(gl_FragColor);
        #include <colorspace_fragment>
      }
    `,
  });
  materials.push(dial);
  const dialMesh = new Mesh(keep(new CircleGeometry(dialRadius, 96)), dial);
  dialMesh.rotation.x = -Math.PI / 2;
  dialMesh.position.y = DAIS_TOP + 0.002;
  dialMesh.renderOrder = 2;
  group.add(dialMesh);

  // Two open rings inlaid in the outer step, turning opposite ways.
  const stepTop = DAIS_STEP;
  const halos = [
    { geometry: new TorusGeometry(2.3, 0.016, 6, 160, Math.PI * 1.45), y: stepTop + 0.004, speed: 0.25 },
    { geometry: new TorusGeometry(2.5, 0.011, 6, 160, Math.PI * 0.85), y: stepTop + 0.002, speed: -0.4 },
    { geometry: new TorusGeometry(2.5, 0.011, 6, 160, Math.PI * 0.85), y: stepTop + 0.002, speed: -0.4, offset: Math.PI },
  ].map((spec) => {
    const mesh = new Mesh(keep(spec.geometry), glow);
    mesh.rotation.order = 'YXZ';
    // Flattened, so they read as lines of light in the surface, not tubes on it.
    mesh.scale.set(1, 1, 0.25);
    mesh.position.y = spec.y;
    group.add(mesh);
    return { mesh, ...spec };
  });

  // Lit dashes inlaid round the outer step, pointing at the centre, with a light chasing round them.
  // Short enough to sit between the outer ring (2.5 m) and the step's edge (2.7 m).
  const postGeometry = keep(new BoxGeometry(0.05, 0.006, 0.12));
  const posts = Array.from({ length: 8 }, (_, i) => {
    const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false });
    materials.push(material);
    const mesh = new Mesh(postGeometry, material);
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    mesh.position.set(Math.sin(angle) * 2.6, stepTop + 0.003, Math.cos(angle) * 2.6);
    mesh.rotation.y = angle;
    group.add(mesh);
    return { mesh, material, angle };
  });

  // A soft pool of light on the floor round the base.
  const pool = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uBoost: boost, uLight: light },
    vertexShader: /* glsl */ `
      varying float vR;
      void main() {
        vR = length(position.xy);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBoost;
      uniform float uLight;
      varying float vR;
      ${SRGB_DECODE}
      void main() {
        float fall = 1.0 - smoothstep(2.85, 5.0, vR);
        // Steady: the beam lights the hall, not this pool.
        float amount = fall * fall * (0.14 + 0.04 * uBoost);
        vec3 color = uLight > 0.5 ? vec3(0.45, 0.45, 0.5) : vec3(1.0);
        gl_FragColor = vec4(color * (uLight > 0.5 ? 1.0 : amount), uLight > 0.5 ? amount * 0.35 : amount);

        // Same on screen as through the beam's pass: decode, then let three encode for wherever this draws.
        gl_FragColor = srgbDecode(gl_FragColor);
        #include <colorspace_fragment>
      }
    `,
  });
  materials.push(pool);
  const poolMesh = new Mesh(keep(new RingGeometry(2.84, 5, 128, 1)), pool);
  poolMesh.rotation.x = -Math.PI / 2;
  poolMesh.position.y = 0.006;
  group.add(poolMesh);

  const setBlending = (material: { blending: number; needsUpdate: boolean }, isLight: boolean) => {
    material.blending = isLight ? NormalBlending : AdditiveBlending;
    material.needsUpdate = true;
  };

  return {
    group,
    step,
    update(now) {
      const dt = Number.isFinite(last) ? Math.min(0.1, Math.max(0, now - last)) : 0;
      last = now;
      boost.value += (presence.value - boost.value) * (1 - Math.exp(-dt * 3));
      for (const halo of halos) halo.mesh.rotation.set(Math.PI / 2, now * halo.speed + (halo.offset ?? 0), 0);
      glow.opacity = 0.8 + 0.1 * boost.value;
      for (const post of posts) {
        const chase = Math.pow(Math.max(0, Math.cos(now * 2.2 - post.angle)), 10);
        post.material.color.copy(glowColor);
        post.material.opacity = Math.min(1, 0.25 + 0.75 * chase + boost.value * 0.15);
      }
    },
    setTheme(isLight) {
      light.value = isLight ? 1 : 0;
      // White light on the dark floor; plain ink on the white one.
      glowColor.set(isLight ? 0x2a2a2e : 0xffffff);
      glow.color.copy(glowColor);
      for (const material of [glow, pool, ...posts.map((post) => post.material)]) setBlending(material, isLight);
      dial.blending = isLight ? NormalBlending : AdditiveBlending;
      dial.needsUpdate = true;
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/**
 * sRGB to linear, for custom shaders that end in three's colour-space chunk:
 * they look the same on screen and through the beam's off-screen pass. (This
 * three.js only gives shaders the other direction.)
 */
const SRGB_DECODE = /* glsl */ `
  vec4 srgbDecode(vec4 value) {
    vec3 c = max(value.rgb, vec3(0.0));
    vec3 low = c * 0.0773993808;
    vec3 high = pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4));
    return vec4(mix(high, low, vec3(lessThanEqual(c, vec3(0.04045)))), value.a);
  }
`;

/** Longest step the spawn effect takes in one frame, and most it catches up on a late start. */
const MAX_FX_STEP = 1 / 30;
const MAX_LAG = 0.25;
/**
 * Quick frames in a row before a spawn beam starts, so it is not played
 * behind a loading stall, and the longest it waits for them after the Walk click.
 */
const SMOOTH_FRAMES = 3;
const MAX_WAIT = 0.5;

export function createSpawnRay(
  height: number,
  /** A layer the floor mirror does not draw: the dais's lights go on it so they are not reflected. */
  unreflectedLayer?: number,
): {
  object: Object3D;
  /** The dais under the beam. Solid, so a visitor can stand on it. */
  colliders: Mesh[];
  setTheme(light: boolean): void;
  /** Restart the fade-in → hold → fade-out when a visitor spawns (this one or
   *  someone else). Pass `performance.now()` from the Walk click so the beam
   *  begins then. While it is still lit, it holds again rather than restarting. */
  trigger(fromWallClock?: number): void;
  /** Drive animations. Returns 0–1 presence of the god-ray (for wobble / refraction). */
  setTime(time: number): number;
  dispose(): void;
} {
  const group = new Group();
  group.name = 'spawn-ray';

  const time = { value: 0 };
  const theme = { value: 0 };
  const presence = { value: 0 };
  const haloMaterial = createGodRayMaterial({ length: height, gain: 0.72, time, theme, presence });
  const beamMaterial = createGodRayMaterial({ length: height, gain: 1.15, time, theme, presence });
  const halo = new Mesh(new CylinderGeometry(1.35, 1.35, height, 128, 64, true), haloMaterial);
  const beam = new Mesh(new CylinderGeometry(0.7, 0.7, height, 160, 80, true), beamMaterial);
  halo.position.y = height / 2;
  beam.position.y = height / 2;
  halo.renderOrder = 1;
  beam.renderOrder = 2;
  group.add(halo, beam);

  // Matte and the floor's own colour, so the dais reads as part of the floor.
  const deckMaterial = new MeshStandardMaterial({ color: 0x030304, roughness: 0.95, metalness: 0 });
  // Not drawn: the hall's own mirror floor shows through, so the dais is the
  // same surface as the ground with only its lines of light on it. Still solid.
  deckMaterial.visible = false;
  const lipMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
  // Low tiers, nearly flush with the floor: 3 cm, then 4 cm at the centre.
  const base = new Mesh(new CylinderGeometry(1.85, 2.05, DAIS_BASE, 64), deckMaterial);
  const top = new Mesh(new CylinderGeometry(1.55, 1.7, DAIS_TOP - DAIS_BASE + 0.005, 64), deckMaterial);
  const lip = new Mesh(new TorusGeometry(1.62, 0.008, 8, 80), lipMaterial);
  // Wider ring on the lower rim of the dais, where it meets the floor.
  const foot = new Mesh(new TorusGeometry(2.05, 0.008, 8, 96), lipMaterial);
  base.position.y = DAIS_BASE / 2;
  top.position.y = (DAIS_BASE + DAIS_TOP) / 2 - 0.0025;
  lip.position.y = DAIS_TOP + 0.002;
  lip.rotation.x = Math.PI / 2;
  foot.position.y = DAIS_STEP + 0.004;
  foot.rotation.x = Math.PI / 2;
  group.add(base, top, lip, foot);
  const dressing = createDaisDressing(time, presence, deckMaterial);
  group.add(dressing.group);
  // The dais's lines of light glow on the floor without a second copy in the mirror under them.
  if (unreflectedLayer !== undefined) {
    for (const mesh of [lip, foot]) mesh.layers.set(unreflectedLayer);
    dressing.group.traverse((child) => {
      if (child instanceof Mesh && child !== dressing.step) child.layers.set(unreflectedLayer);
    });
  }

  const pulseGlow = (seed: number) =>
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: { uTime: time, uOpacity: { value: 0 }, uSeed: { value: seed } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uOpacity;
        uniform float uSeed;
        varying vec2 vUv;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        ${SRGB_DECODE}
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float inner = 1.46 / 1.64;
          float edge = smoothstep(inner - 0.02, inner + 0.08, r) * (1.0 - smoothstep(0.88, 1.0, r));
          vec2 drift = vUv * vec2(3.0, 9.0) + vec2(uSeed, -uTime * 0.35);
          float n = noise(drift) * 0.65 + noise(drift * 2.4 + uTime * 0.22) * 0.35;
          float alpha = uOpacity * (0.35 + 0.65 * n) * edge;
          vec3 color = vec3(1.8, 1.85, 2.1);
          float ca = 0.04 * sin(atan(p.y, p.x) * 2.0 + uSeed);
          color.r *= 1.0 + ca;
          color.b *= 1.0 - ca;
          gl_FragColor = vec4(color, alpha);
          // Same on screen as through the beam's pass: decode, then let three encode for wherever this draws.
          gl_FragColor = srgbDecode(gl_FragColor);
          #include <colorspace_fragment>
        }
      `,
    });
  const rimGeometry = new RingGeometry(1.46, 1.64, 128);
  const pulses = Array.from({ length: 8 }, (_, index) => {
    const rimMaterial = pulseGlow(index * 1.7);
    const rim = new Mesh(rimGeometry, rimMaterial);
    rim.rotation.x = -Math.PI / 2;
    rim.renderOrder = 3;
    group.add(rim);
    return { mesh: rim, rimMaterial, born: -1, radius: 1.55 };
  });
  let nextPulse = 0.4;

  const sparkCount = 290;
  const sparkAlphas = new Float32Array(sparkCount);
  const sparkHues = new Float32Array(sparkCount);
  const sparkBorn = new Float32Array(sparkCount).fill(-1);
  const sparkRadius = new Float32Array(sparkCount);
  const sparkAngle = new Float32Array(sparkCount);
  const sparkSpeed = new Float32Array(sparkCount);
  const sparkLength = new Float32Array(sparkCount);
  const sparkGeometry = new BoxGeometry(1, 1, 1);
  const sparkAlphaAttr = new InstancedBufferAttribute(sparkAlphas, 1);
  const sparkHueAttr = new InstancedBufferAttribute(sparkHues, 1);
  sparkAlphaAttr.setUsage(DynamicDrawUsage);
  sparkHueAttr.setUsage(DynamicDrawUsage);
  sparkGeometry.setAttribute('aAlpha', sparkAlphaAttr);
  sparkGeometry.setAttribute('aHue', sparkHueAttr);
  const sparkMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
    uniforms: { uLight: theme },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      attribute float aHue;
      varying float vAlpha;
      varying float vHue;
      void main() {
        vAlpha = aAlpha;
        vHue = aHue;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLight;
      varying float vAlpha;
      varying float vHue;
      ${SRGB_DECODE}
      void main() {
        vec3 color = mix(vec3(1.15, 1.25, 1.5), vec3(1.1, 1.05, 0.85), uLight);
        float ca = 0.05 * sin(vHue);
        color.r *= 1.0 + ca;
        color.b *= 1.0 - ca;
        gl_FragColor = vec4(color, vAlpha * mix(0.75, 0.4, uLight));

        // Same on screen as through the beam's pass: decode, then let three encode for wherever this draws.
        gl_FragColor = srgbDecode(gl_FragColor);
        #include <colorspace_fragment>
      }
    `,
  });
  const sparks = new InstancedMesh(sparkGeometry, sparkMaterial, sparkCount);
  sparks.renderOrder = 4;
  sparks.frustumCulled = false;
  sparks.instanceMatrix.setUsage(DynamicDrawUsage);
  group.add(sparks);
  const sparkDummy = new Object3D();
  for (let i = 0; i < sparkCount; i++) {
    sparkDummy.position.set(0, -20, 0);
    sparkDummy.scale.set(0.001, 0.001, 0.001);
    sparkDummy.updateMatrix();
    sparks.setMatrixAt(i, sparkDummy.matrix);
  }
  sparks.instanceMatrix.needsUpdate = true;
  let nextSpark = 0.2;
  let pendingTrigger = false;
  let startedAt = Number.NEGATIVE_INFINITY;
  let triggerWallClock = 0;
  // The effect runs on its own clock, which moves with rendered frames and at
  // most 1/30 s per frame. While the lobby is still loading, frames stall; on
  // the wall clock the beam would jump through its fade in a few big steps.
  let clock = 0;
  let lastNow = Number.NaN;
  /** Quick frames in a row; the beam waits for the hall to be running smoothly. */
  let smoothFrames = 0;

  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
  /** Up quickly from the first frame, easing into full. */
  const easeOutCubic = (t: number) => {
    const u = 1 - clamp01(t);
    return 1 - u * u * u;
  };

  return {
    object: group,
    colliders: [dressing.step, base, top],
    setTheme(light: boolean) {
      theme.value = light ? 1 : 0;
      deckMaterial.color.set(light ? 0xf1f4fa : 0x030304);
      deckMaterial.emissive.set(light ? 0x6b707c : 0x000000);
      lipMaterial.color.set(light ? 0x3a3d44 : 0xffffff);
      dressing.setTheme(light);
    },
    trigger(fromWallClock = performance.now()) {
      pendingTrigger = true;
      triggerWallClock = fromWallClock;
    },
    setTime(realNow: number) {
      time.value = realNow;
      dressing.update(realNow);
      const real = Number.isFinite(lastNow) ? realNow - lastNow : Number.POSITIVE_INFINITY;
      const step = Number.isFinite(real) ? Math.min(Math.max(real, 0), MAX_FX_STEP) : 0;
      lastNow = realNow;
      smoothFrames = real < 0.1 ? smoothFrames + 1 : 0;
      clock += step;
      const now = clock;
      // A quick fade in → a hold → a slow, even fade out.
      const fadeIn = 0.45;
      const hold = 0.5;
      const fadeOut = 0.9;
      if (pendingTrigger && presence.value > 0.02) {
        // Already lit (someone else arrived a moment ago): carry on from the
        // same brightness on the way up, and hold again, instead of dropping to dark.
        pendingTrigger = false;
        startedAt = now - (1 - Math.cbrt(1 - presence.value)) * fadeIn;
      } else if (pendingTrigger && (smoothFrames >= SMOOTH_FRAMES || (performance.now() - triggerWallClock) / 1000 > MAX_WAIT)) {
        pendingTrigger = false;
        // Catch up a little on the time since the Walk click, never so much that it starts half faded.
        const lag = Math.min(MAX_LAG, Math.max(0, (performance.now() - triggerWallClock) / 1000));
        startedAt = now - lag;
        nextPulse = now + 0.25;
        nextSpark = now + 0.08;
        for (const pulse of pulses) {
          pulse.born = -1;
          pulse.rimMaterial.uniforms.uOpacity.value = 0;
          pulse.mesh.visible = false;
        }
        for (let i = 0; i < sparkCount; i++) sparkBorn[i] = -1;
      }
      const age = now - startedAt;
      let amount = 0;
      let dying = 0;
      if (age >= 0 && age < fadeIn) {
        amount = easeOutCubic(age / fadeIn);
      } else if (age >= fadeIn && age < fadeIn + hold) {
        amount = 1;
      } else if (age >= fadeIn + hold && age < fadeIn + hold + fadeOut) {
        // An even S-curve: no sudden drop at the start of the fade.
        const t = clamp01((age - fadeIn - hold) / fadeOut);
        dying = t * t * (3 - 2 * t);
        amount = 1 - dying;
      }
      presence.value = amount;
      lipMaterial.opacity = 1;
      const live = amount > 0.02;
      halo.visible = live;
      beam.visible = live;
      // Full width until death; then a moderate shrink while it goes transparent.
      const radiusScale = live ? 1 - 0.45 * dying : 0.55;
      halo.scale.set(radiusScale, 1, radiusScale);
      beam.scale.set(radiusScale, 1, radiusScale);

      if (amount > 0.15 && now >= nextPulse) {
        const pulse = pulses.find((entry) => entry.born < 0);
        if (pulse) {
          pulse.born = now;
          pulse.radius = 1.4 + Math.random() * 0.35;
          nextPulse = now + 0.55 + Math.random() * 0.95;
        }
      }
      const rise = height * 0.62;
      for (const pulse of pulses) {
        const pulseAge = now - pulse.born;
        const climbed = pulse.born < 0 ? rise : pulseClimb(pulseAge);
        if (pulse.born < 0 || climbed >= rise || amount < 0.02) {
          if (climbed >= rise) pulse.born = -1;
          pulse.rimMaterial.uniforms.uOpacity.value = 0;
          pulse.mesh.visible = false;
          continue;
        }
        pulse.mesh.visible = true;
        const u = climbed / rise;
        pulse.mesh.position.y = 0.16 + climbed;
        const scale = (pulse.radius / 1.55) * (1 - u * 0.72) * radiusScale;
        pulse.mesh.scale.set(scale, scale, scale);
        const appear = Math.min(1, pulseAge / 0.5);
        const fadeInPulse = appear * appear * (3 - 2 * appear);
        const fade = fadeInPulse * (1 - u) * (1 - u * 0.35);
        pulse.rimMaterial.uniforms.uOpacity.value = fade * amount * (theme.value ? 0.08 : 0.14);
      }

      if (amount > 0.4) {
        while (now >= nextSpark) {
          let slot = -1;
          for (let i = 0; i < sparkCount; i++) {
            if (sparkBorn[i]! < 0) {
              slot = i;
              break;
            }
          }
          if (slot < 0) break;
          sparkBorn[slot] = now;
          sparkRadius[slot] = Math.random() * 1.45;
          sparkAngle[slot] = Math.random() * Math.PI * 2;
          sparkSpeed[slot] = 5.5 + Math.random() * 2.5;
          sparkLength[slot] = 0.14 + Math.random() * 0.2;
          nextSpark += 0.006 + Math.random() * 0.015;
        }
      }
      if (nextSpark < now) nextSpark = now;
      const sparkRise = 10;
      const sparkThickness = 0.022;
      // Burn out well before the top: shrink + fade hard, then gone.
      const sparkLife = 0.58;
      // As the beam itself ends, clear remaining streaks sooner.
      const beamEnd = amount >= 0.55 ? 1 : amount <= 0.02 ? 0 : amount / 0.55;
      for (let i = 0; i < sparkCount; i++) {
        const bornAt = sparkBorn[i]!;
        if (bornAt < 0) {
          sparkAlphas[i] = 0;
          sparkDummy.position.set(0, -20, 0);
          sparkDummy.scale.set(0.001, 0.001, 0.001);
          sparkDummy.updateMatrix();
          sparks.setMatrixAt(i, sparkDummy.matrix);
          continue;
        }
        const sparkAge = now - bornAt;
        const climbed = Math.min(sparkRise, sparkAge * sparkSpeed[i]!);
        const heightU = climbed / sparkRise;
        const lifeU = Math.min(1, heightU / sparkLife);
        if (lifeU >= 0.999 || beamEnd <= 0.001) {
          sparkBorn[i] = -1;
          sparkAlphas[i] = 0;
          sparkDummy.position.set(0, -20, 0);
          sparkDummy.scale.set(0.001, 0.001, 0.001);
          sparkDummy.updateMatrix();
          sparks.setMatrixAt(i, sparkDummy.matrix);
          continue;
        }
        const r = sparkRadius[i]!;
        const ang = sparkAngle[i]!;
        const die = lifeU * lifeU;
        const dieOut = die * die;
        const keep = (1 - dieOut) * beamEnd;
        const len = sparkLength[i]! * (0.35 + 0.65 * keep);
        const thick = sparkThickness * (0.2 + 0.8 * keep);
        const y = 0.18 + climbed;
        sparkDummy.position.set(Math.cos(ang) * r, y - len * 0.5, Math.sin(ang) * r);
        sparkDummy.scale.set(Math.max(0.004, thick), Math.max(0.008, len), Math.max(0.004, thick));
        sparkDummy.updateMatrix();
        sparks.setMatrixAt(i, sparkDummy.matrix);
        const appear = Math.min(1, sparkAge / 0.2);
        const fadeInSpark = appear * appear * (3 - 2 * appear);
        sparkAlphas[i] = fadeInSpark * keep * keep * 0.5;
        sparkHues[i] = ang;
      }
      sparks.instanceMatrix.needsUpdate = true;
      sparkAlphaAttr.needsUpdate = true;
      sparkHueAttr.needsUpdate = true;
      return amount;
    },
    dispose() {
      halo.geometry.dispose();
      beam.geometry.dispose();
      haloMaterial.dispose();
      beamMaterial.dispose();
      base.geometry.dispose();
      top.geometry.dispose();
      lip.geometry.dispose();
      foot.geometry.dispose();
      deckMaterial.dispose();
      lipMaterial.dispose();
      dressing.dispose();
      rimGeometry.dispose();
      for (const pulse of pulses) pulse.rimMaterial.dispose();
      sparkGeometry.dispose();
      sparkMaterial.dispose();
    },
  };
}

// ── The citadel's banners ────────────────────────────────────────────────────

/**
 * Pictures hung where a visitor looks. The tall ones face the plaza from
 * above each gate. The wide one faces into the hall.
 */
export interface BannerArt {
  texture: Texture;
  material: MeshBasicMaterial;
  /** Width divided by height. */
  aspect: number;
}

const BANNER_ART = {
  explore: { url: '/banners/explore.jpg', aspect: 512 / 1024 },
  discover: { url: '/banners/discover.jpg', aspect: 576 / 1024 },
  platform: { url: '/banners/platform.jpg', aspect: 1024 / 341 },
} as const;

function loadBanner(url: string, aspect: number, anisotropy: number): BannerArt {
  const texture = new TextureLoader().load(url);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  return { texture, material, aspect };
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
  banners: {
    explore: BannerArt;
    discover: BannerArt;
    platform: BannerArt;
  };
  dispose(): void;
}

/** The citadel's light trim and banner art, shared by every rebuild. */
export function createCityMaterials(anisotropy: number): CityMaterials {
  const banners = {
    explore: loadBanner(BANNER_ART.explore.url, BANNER_ART.explore.aspect, anisotropy),
    discover: loadBanner(BANNER_ART.discover.url, BANNER_ART.discover.aspect, anisotropy),
    platform: loadBanner(BANNER_ART.platform.url, BANNER_ART.platform.aspect, anisotropy),
  };
  return {
    glow: new MeshBasicMaterial({ toneMapped: false, side: DoubleSide }),
    banners,
    dispose() {
      this.glow.dispose();
      for (const art of Object.values(this.banners)) {
        art.texture.dispose();
        art.material.dispose();
      }
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

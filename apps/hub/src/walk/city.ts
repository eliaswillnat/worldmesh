import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
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
 * A shaft of light landing on the hall's centre, where a visitor appears.
 * The streaks are the Paper Design god-ray shader (Apache-2.0), mapped so
 * they fan down the column from the open roof. The noise texture is replaced
 * with the same package's hash, and the colours stay white.
 */
function glowNoise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const hash = (n: number) => {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  return hash(i) * (1 - u) + hash(i + 1) * u;
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

export function createSpawnRay(height: number): {
  object: Object3D;
  /** The dais under the beam. Solid, so a visitor can stand on it. */
  colliders: Mesh[];
  setTheme(light: boolean): void;
  /** Restart the fade-in → hold → fade-out when the visitor spawns.
   *  Pass `performance.now()` from the Walk click so the beam begins then. */
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
  const shaft = (gain: number) =>
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: { uTime: time, uLight: theme, uGain: { value: gain }, uPresence: presence },
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec3 vWorld;
        void main() {
          vLocal = position;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uLight;
        uniform float uGain;
        uniform float uPresence;
        #define TWO_PI 6.28318530718
        #define PI 3.14159265359
        varying vec3 vLocal;
        varying vec3 vWorld;

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

        void main() {
          if (uPresence < 0.001) discard;
          vec3 axis = normalize(vec3(vLocal.x, 0.0, vLocal.z));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float ndot = abs(dot(axis, viewDir));
          float facing = smoothstep(0.0, 0.78, ndot);
          facing *= facing;
          float height = ${height.toFixed(1)};
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
            vec3 tint = i == 0 ? tint0 : i == 1 ? tint1 : i == 2 ? tint2 : tint3;
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
            vec3 srcColor = tint * srcAlpha;
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
          float alpha = facing * accumAlpha * base * tip * uGain * uPresence * mix(1.0, 0.55, uLight);
          vec3 color = accumColor * mix(vec3(6.0), vec3(4.2, 4.0, 3.6), uLight);
          // Soft object-space chromatic fringe, not view-dependent.
          float ca = 0.045 * sin(ang * 2.0 + uTime * 0.15);
          color.r *= 1.0 + ca;
          color.b *= 1.0 - ca;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }
      `,
    });

  const haloMaterial = shaft(0.72);
  const beamMaterial = shaft(1.15);
  const halo = new Mesh(new CylinderGeometry(1.35, 1.35, height, 128, 64, true), haloMaterial);
  const beam = new Mesh(new CylinderGeometry(0.7, 0.7, height, 160, 80, true), beamMaterial);
  halo.position.y = height / 2;
  beam.position.y = height / 2;
  halo.renderOrder = 1;
  beam.renderOrder = 2;
  group.add(halo, beam);

  const deckMaterial = new MeshStandardMaterial({ color: 0x141418, roughness: 0.42, metalness: 0.08 });
  const lipMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
  const base = new Mesh(new CylinderGeometry(1.85, 2.05, 0.06, 64), deckMaterial);
  const top = new Mesh(new CylinderGeometry(1.55, 1.7, 0.05, 64), deckMaterial);
  const lip = new Mesh(new TorusGeometry(1.62, 0.008, 8, 80), lipMaterial);
  // Wider ring on the lower rim of the dais, where it meets the floor.
  const foot = new Mesh(new TorusGeometry(2.05, 0.008, 8, 96), lipMaterial);
  base.position.y = 0.03;
  top.position.y = 0.08;
  lip.position.y = 0.108;
  lip.rotation.x = Math.PI / 2;
  foot.position.y = 0.012;
  foot.rotation.x = Math.PI / 2;
  group.add(base, top, lip, foot);

  const spot = new SpotLight(0xffffff, 180, 48, 0.07, 0.45, 0.7);
  spot.position.set(0, 34, 0);
  spot.target.position.set(0, 0, 0);
  const fill = new PointLight(0xeef3ff, 150, 56, 1.45);
  fill.position.set(0, 8, 0);
  group.add(spot, spot.target, fill);
  let spotBase = 180;
  let fillBase = 150;

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
      void main() {
        vec3 color = mix(vec3(1.15, 1.25, 1.5), vec3(1.1, 1.05, 0.85), uLight);
        float ca = 0.05 * sin(vHue);
        color.r *= 1.0 + ca;
        color.b *= 1.0 - ca;
        gl_FragColor = vec4(color, vAlpha * mix(0.75, 0.4, uLight));
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

  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
  /** Strong slow start, fast finish. */
  const easeInQuint = (t: number) => {
    const x = clamp01(t);
    return x * x * x * x * x;
  };
  /** Fast start, very soft landing. */
  const easeOutQuint = (t: number) => {
    const x = clamp01(t);
    const u = 1 - x;
    return 1 - u * u * u * u * u;
  };

  return {
    object: group,
    colliders: [base, top],
    setTheme(light: boolean) {
      theme.value = light ? 1 : 0;
      spotBase = light ? 90 : 180;
      fillBase = light ? 36 : 150;
      spot.color.set(0xffffff);
      deckMaterial.color.set(light ? 0xf4f1ea : 0x141418);
      deckMaterial.emissive.set(light ? 0x6b707c : 0x000000);
      lipMaterial.color.set(light ? 0x3a3d44 : 0xffffff);
    },
    trigger(fromWallClock = performance.now()) {
      pendingTrigger = true;
      triggerWallClock = fromWallClock;
    },
    setTime(now: number) {
      time.value = now;
      if (pendingTrigger) {
        pendingTrigger = false;
        // Age includes time since the Walk click, not since this frame.
        const lag = Math.max(0, (performance.now() - triggerWallClock) / 1000);
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
      // Fade in (ease-in) → brief hold → fade out (ease-out).
      const age = now - startedAt;
      const fadeIn = 0.7;
      const hold = 0.75;
      const fadeOut = 0.65;
      let amount = 0;
      let dying = 0;
      if (age >= 0 && age < fadeIn) {
        amount = easeInQuint(age / fadeIn);
      } else if (age >= fadeIn && age < fadeIn + hold) {
        amount = 1;
      } else if (age >= fadeIn + hold && age < fadeIn + hold + fadeOut) {
        dying = easeOutQuint((age - fadeIn - hold) / fadeOut);
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

      const a = Math.sin(now * 0.37);
      const b = Math.sin(now * 0.91 + 1.7);
      const flicker = 0.86 + 0.09 * a + 0.05 * b;
      spot.intensity = spotBase * flicker * amount;
      const shimmer = glowNoise(now * 2.8) * 0.55 + glowNoise(now * 6.4 + 4.2) * 0.3 + glowNoise(now * 11.5 + 1.7) * 0.15;
      fill.intensity = fillBase * (0.4 + 0.85 * shimmer) * amount;

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
      rimGeometry.dispose();
      for (const pulse of pulses) pulse.rimMaterial.dispose();
      sparkGeometry.dispose();
      sparkMaterial.dispose();
      spot.dispose();
      fill.dispose();
    },
  };
}

/**
 * A light screen-space bend when leaving the spawn shaft: chromatic offset
 * and a soft radial warp, peaking at the rim. Cheaper than MeshTransmissionMaterial.
 * Hooks renderer.render for the final on-screen pass only; Reflector RT draws pass through.
 */
export function createBeamRefraction(renderer: WebGLRenderer, viewCamera: PerspectiveCamera): {
  update(dt: number, x: number, z: number, time: number, presence?: number): void;
  resize(): void;
  dispose(): void;
} {
  const target = new WebGLRenderTarget(1, 1, { depthBuffer: true });
  target.texture.colorSpace = LinearSRGBColorSpace;
  const uniforms = {
    tDiffuse: { value: target.texture },
    uStrength: { value: 0 },
    uCenter: { value: new Vector2(0.5, 0.5) },
    uTime: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uStrength;
      uniform vec2 uCenter;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec3 clean = texture2D(tDiffuse, vUv).rgb;
        float strength = clamp(uStrength, 0.0, 1.0);
        if (strength < 0.001) {
          gl_FragColor = vec4(clean, 1.0);
        } else {
          vec2 delta = vUv - uCenter;
          float dist = length(delta);
          vec2 dir = dist > 1e-4 ? delta / dist : vec2(0.0);
          float wobble = 0.65 + 0.35 * sin(uTime * 4.2 + dist * 28.0);
          float amount = strength * 0.022 * wobble;
          vec2 offset = dir * amount * (0.35 + dist * 1.4);
          float r = texture2D(tDiffuse, clamp(vUv + offset * 1.35, 0.0, 1.0)).r;
          float g = texture2D(tDiffuse, clamp(vUv + offset, 0.0, 1.0)).g;
          float b = texture2D(tDiffuse, clamp(vUv + offset * 0.7, 0.0, 1.0)).b;
          gl_FragColor = vec4(mix(clean, vec3(r, g, b), strength), 1.0);
        }
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), material));
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let leavePulse = 0;
  let prevDist = 0;
  let strength = 0;
  let strengthShown = 0;
  const beam = new Vector3(0, 1.4, 0);
  const projected = new Vector3();
  const originalRender = renderer.render.bind(renderer);
  let composing = false;

  renderer.render = ((renderScene, renderCamera) => {
    if (composing || renderer.getRenderTarget() !== null || strengthShown < 0.002) {
      return originalRender(renderScene, renderCamera);
    }
    composing = true;
    const prevTone = renderer.toneMapping;
    const prevSpace = renderer.outputColorSpace;
    // Keep the intermediate buffer linear so the final pass matches a normal frame.
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.setRenderTarget(target);
    originalRender(renderScene, renderCamera);
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
    renderer.outputColorSpace = prevSpace;
    originalRender(scene, cam);
    composing = false;
  }) as typeof renderer.render;

  const resize = () => {
    const width = Math.max(1, renderer.domElement.width);
    const height = Math.max(1, renderer.domElement.height);
    target.setSize(width, height);
  };
  resize();

  return {
    update(dt, x, z, time, beamPresence = 1) {
      const dist = Math.hypot(x, z);
      const rim = 0.85;
      if (prevDist < rim && dist >= rim) leavePulse = 1;
      leavePulse = Math.max(0, leavePulse - dt * 1.6);
      // Narrow shell around the rim: only while still close to the shaft.
      const away = Math.abs(dist - rim) / 1.05;
      const edge = away >= 1 ? 0 : 1 - away * away * (3 - 2 * away);
      strength = Math.max(leavePulse * 0.75, edge * 0.4) * Math.max(0, beamPresence);
      const ease = 1 - Math.exp(-dt * 3.2);
      strengthShown += (strength - strengthShown) * ease;
      prevDist = dist;

      projected.copy(beam).project(viewCamera);
      uniforms.uCenter.value.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
      uniforms.uStrength.value = strengthShown;
      uniforms.uTime.value = time;
    },
    resize,
    dispose() {
      renderer.render = originalRender;
      target.dispose();
      material.dispose();
      (scene.children[0] as Mesh).geometry.dispose();
    },
  };
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

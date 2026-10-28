import { BackSide, Color, DoubleSide, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from 'three';

/**
 * What the street is drawn with besides its buildings: the sky dome over it,
 * and the lines of light along the storefronts.
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
  uniform float uTime;
  uniform float uAurora;
  uniform float uDaylight;
  varying vec3 vDirection;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Noise read round a circle, so it wraps the sky without a seam.
  float ring(float azimuth, float frequency, float drift) {
    return noise(vec2(cos(azimuth), sin(azimuth)) * frequency + drift);
  }

  // The colours run across the sky, not up it: teal, sky blue, periwinkle, dusty rose
  // and back, six times round, so neighbouring curtains differ, drifting slowly.
  vec3 auroraPalette(float x) {
    float t = fract(x) * 4.0;
    float f = smoothstep(0.0, 1.0, fract(t));
    vec3 teal = vec3(0.25, 0.8, 0.7);
    vec3 blue = vec3(0.3, 0.68, 0.95);
    vec3 periwinkle = vec3(0.5, 0.48, 0.95);
    vec3 rose = vec3(0.85, 0.5, 0.78);
    if (t < 1.0) return mix(teal, blue, f);
    if (t < 2.0) return mix(blue, periwinkle, f);
    if (t < 3.0) return mix(periwinkle, rose, f);
    return mix(rose, teal, f);
  }

  // Curtains of broad vertical rays rising from a wavy hem above the horizon. The hem
  // melts into the sky rather than ending on a line, and the straight curtains sway and
  // pulse as they drift round. Returns the colour and, in alpha, how much aurora there is.
  vec4 aurora(vec3 direction) {
    float h = direction.y;
    float azimuth = atan(direction.z, direction.x);
    vec3 color = vec3(0.0);
    float amount = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      // Swaying side to side as a whole, so the rays stay straight as they move.
      float sway = 0.03 * sin(uTime * 0.35 + azimuth * 4.0 + fi * 2.0)
        + 0.015 * sin(uTime * 0.6 - azimuth * 7.0 + fi);
      float a = azimuth + sway;
      float hem = 0.14 + 0.05 * fi + 0.12 * (ring(a + fi, 1.5, uTime * 0.08 + fi * 7.0) - 0.5);
      float above = h - hem;
      // A soft fall-off below the hem and a long fade above it, so no edge shows.
      float below = min(above, 0.0) / 0.07;
      float body = exp(-below * below) * exp(-max(above, 0.0) / (0.1 + 0.04 * fi));
      float rays = ring(a + fi * 2.0, 14.0 + 4.0 * fi, uTime * 0.12 + fi * 3.0);
      rays = 0.25 + 0.75 * rays * rays;
      float curtain = smoothstep(0.4, 0.8, ring(a - fi, 2.0, uTime * 0.05 + fi * 11.0));
      float pulse = 0.8 + 0.2 * sin(uTime * 0.5 + fi * 2.1 + azimuth * 2.0);
      float strength = body * rays * curtain * pulse;
      color += auroraPalette(azimuth * 3.0 / 3.14159265 + fi * 0.08 + uTime * 0.02) * strength;
      amount += strength;
    }
    // Gone by the horizon, where the fog has to meet the sky's own colour.
    float fade = smoothstep(0.0, 0.1, h);
    return vec4(color * fade, amount * fade);
  }

  void main() {
    vec3 direction = normalize(vDirection);
    float h = clamp(direction.y, 0.0, 1.0);
    // Light: pale at the horizon, a clean saturated blue overhead.
    // Dark: a faint grey at the horizon, deepening to black overhead.
    vec3 color = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.75, h), uCurve));
    vec4 glow = aurora(direction);
    // At night they glow, screened over the dark so they never blow out. By day a glow
    // would vanish into the blue, so they tint it instead, in their own colours.
    vec3 screened = 1.0 - (1.0 - color) * (1.0 - clamp(glow.rgb * uAurora, 0.0, 1.0));
    vec3 tint = glow.rgb / max(glow.a, 0.0001);
    // Deepened, so the pastel colours still stand apart from the blue, then lifted with white.
    vec3 tinted = mix(color, mix(tint * tint * 1.2, vec3(1.0), 0.4), clamp(glow.a * uAurora, 0.0, 0.5));
    color = mix(screened, tinted, uDaylight);
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

/** How strongly the auroras show: how much they tint the day's blue, and glow at night. */
const AURORA = 0.85;
const AURORA_DARK = 0.4;

/** A gradient dome with faint auroras. Move it with the player so it never gets closer. */
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
        uTime: { value: 0 },
        uAurora: { value: AURORA },
        uDaylight: { value: 1 },
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
  uniforms.uAurora.value = light ? AURORA : AURORA_DARK;
  uniforms.uDaylight.value = light ? 1 : 0;
}

/** Let the auroras drift; `time` in seconds. */
export function updateSky(sky: Mesh<SphereGeometry, ShaderMaterial>, time: number): void {
  sky.material.uniforms.uTime.value = time;
}

export interface CityMaterials {
  /** The lines of light along the storefronts. */
  glow: MeshBasicMaterial;
  dispose(): void;
}

/** The street's light trim, shared by every rebuild. */
export function createCityMaterials(): CityMaterials {
  return {
    glow: new MeshBasicMaterial({ toneMapped: false, side: DoubleSide }),
    dispose() {
      this.glow.dispose();
    },
  };
}

export function applyCityTheme(materials: CityMaterials, light: boolean): void {
  materials.glow.color.set(light ? 0x3a3d44 : 0xffffff);
}

import {
  BackSide,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  type BufferGeometry,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityConfig } from './config';
import { PALETTES, setLayer, type CityMaterials } from './materials';
import type { TowerPlan } from './plan';
import { drawBand, SIGN_FONT, spaced } from './signage';

/**
 * A tower's always-on representation: one exterior drum and one interior
 * drum, each a single draw call whose shader paints floors, fluting, window
 * slits and light coves procedurally from world height. The drums are far
 * taller than anyone can see, so the tower fades into the fog instead of
 * ending: there is no ceiling to find.
 *
 * Openings (the entrance, bridge mouths) are cut in the shader, so they cost
 * nothing extra. Detail (floors, doors) only exists near the player; see
 * towerDetail.ts.
 */

const MAX_OPENINGS = 8;

const shellVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const shellFragment = /* glsl */ `
  #define MAX_OPENINGS ${MAX_OPENINGS}
  uniform vec3 uBase;
  uniform vec3 uLine;
  uniform vec3 uGlow;
  uniform vec3 uAccent;
  uniform vec3 uSun;
  uniform vec2 uCenter;
  uniform float uRadius;
  uniform float uFloorHeight;
  uniform float uBridgeEvery;
  uniform float uTopFloor;
  uniform float uInterior;
  uniform float uNight;
  uniform float uSignBottom;
  uniform float uSignTop;
  uniform vec4 uOpenings[MAX_OPENINGS];
  uniform int uOpeningCount;
  varying vec3 vWorld;
  varying vec3 vNormal;
  #include <common>
  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // 1 on a line of half-width w (in the coordinate's own units), antialiased.
  float line(float x, float w) {
    float aa = fwidth(x) * 1.2;
    return 1.0 - smoothstep(w, w + aa, abs(x));
  }

  void main() {
    vec2 d = vWorld.xz - uCenter;
    float ang = atan(d.x, d.y);
    for (int i = 0; i < MAX_OPENINGS; i++) {
      if (i >= uOpeningCount) break;
      vec4 o = uOpenings[i];
      float da = abs(mod(ang - o.x + PI, 2.0 * PI) - PI);
      if (da < o.y && vWorld.y > o.z && vWorld.y < o.w) discard;
    }

    float y = vWorld.y;
    float fl = y / uFloorHeight;
    float f = fract(fl);
    float floorIndex = floor(fl);
    float s = ang * uRadius;
    vec3 n = normalize(vNormal) * (uInterior > 0.5 ? -1.0 : 1.0);
    vec3 color;

    if (uInterior < 0.5) {
      // Exterior: vertical fluting, floor joints, a band of window slits per floor.
      float rib = s / 3.2;
      float day = 1.0 - uNight;
      // Daylight fluting stays faint, so the wall reads as the citadel's flat white.
      float fluteDepth = mix(0.1, 0.025, day);
      float flute = 1.0 - fluteDepth + fluteDepth * cos(rib * 2.0 * PI);
      color = uBase * flute;
      float joint = line(f, 0.012) ;
      color = mix(color, uLine, joint * 0.8);
      float plinth = step(y, 9.0);
      float slitX = abs(fract(rib) - 0.5);
      float inSign = step(uSignBottom, y) * step(y, uSignTop);
      float slit = (1.0 - smoothstep(0.07, 0.07 + fwidth(rib) * 1.5, slitX)) * step(0.34, f) * step(f, 0.78) * (1.0 - plinth) * (1.0 - inSign);
      float lit = step(0.38, hash21(vec2(floor(rib), floorIndex))) * step(floorIndex, uTopFloor);
      vec3 glass = mix(uLine * 0.7, uGlow, lit * uNight * 0.85);
      color = mix(color, glass, slit);
      // Setback ledges at every bridge level, with a thin accent line.
      float level = mod(floorIndex, uBridgeEvery);
      float isLedge = step(level, 0.5) * step(1.0, floorIndex);
      color = mix(color, uBase * 1.18, isLedge * step(f, 0.1));
      color = mix(color, uAccent, isLedge * line(f - 0.1, 0.006) * 0.9);
      color *= mix(1.0, mix(0.72, 0.98, day), plinth);
      // Simple lighting: sky from above, sun from the side.
      float sun = max(dot(n, normalize(uSun)), 0.0);
      // Night keeps the shaded drum. Day stays white the way the citadel wall does.
      float nightLight = 0.62 + 0.5 * sun + 0.12 * n.y;
      float dayLight = 0.96 + 0.04 * sun;
      color *= mix(nightLight, dayLight, day);
      color += glass * slit * lit * uNight * 0.35;
    } else {
      // Interior: pilasters, a dark skirting per floor and a light cove under each slab.
      float pil = s / 4.6;
      float pilaster = line(fract(pil) - 0.5, 0.04);
      float day = 1.0 - uNight;
      color = uBase * mix(0.86 + 0.14 * pilaster, 0.97 + 0.03 * pilaster, day);
      color = mix(color, uLine, step(f, 0.07) * mix(0.7, 0.25, day));
      float cove = line(f - 0.945, 0.006);
      float spill = smoothstep(0.6, 0.94, f) * mix(0.25, 0.08, day);
      color *= mix(0.7, 0.96, day) + spill;
      color = mix(color, uGlow, cove * (0.55 + 0.45 * uNight));
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** A picture hung on the outside of a tower. */
export interface TowerBanner {
  material: MeshBasicMaterial;
  /** Width divided by height. */
  aspect: number;
}

export interface TowerShell {
  readonly group: Group;
  readonly exterior: Mesh;
  readonly interior: Mesh;
  /** Invisible: the outer wall at ground level, and the jambs of every opening. */
  readonly colliders: Mesh[];
  setTheme(light: boolean): void;
  /** Interior drum only draws when someone is in or near the tower. */
  setInteriorVisible(visible: boolean): void;
  /** Spin the signs that travel around the drum. */
  update(dt: number): void;
  dispose(): void;
}

interface HungBanners {
  meshes: Mesh[];
  /** Rigs that travel around the tower, in radians per second. */
  orbits: { rig: Group; speed: number }[];
}

/** A sign bent onto the drum. `turn` aims it; the arc itself is centred on local +Z. */
function placeSign(
  parent: Group,
  radius: number,
  art: TowerBanner,
  portraitHeight: number,
  wideHeight: number,
  bottom: number,
  bezelMaterial: MeshBasicMaterial,
): { rig: Group; meshes: Mesh[] } {
  const portrait = art.aspect < 1;
  const height = portrait ? portraitHeight : wideHeight;
  const width = Math.min(height * art.aspect, radius * 1.65);
  const arc = width / radius;
  const segments = Math.max(18, Math.ceil(arc * 28));
  const screen = new Mesh(
    new CylinderGeometry(radius, radius, height, segments, 1, true, -arc / 2, arc),
    art.material,
  );
  screen.position.y = bottom + height / 2;
  const bezel = new Mesh(
    new CylinderGeometry(radius - 0.2, radius - 0.2, height + 0.85, segments, 1, true, -arc / 2 - 0.36 / radius, arc + 0.72 / radius),
    bezelMaterial,
  );
  bezel.position.y = screen.position.y;
  const rig = new Group();
  rig.add(bezel, screen);
  parent.add(rig);
  return { rig, meshes: [bezel, screen] };
}

/**
 * A few large pictures on the outside of the drum. Two stay put (one over the
 * entrance, one around the side). Two more circle the tower above them.
 */
function hangBanners(
  group: Group,
  outer: number,
  entrance: number,
  banners: TowerBanner[],
  variety: number,
  bezelMaterial: MeshBasicMaterial,
): HungBanners {
  if (banners.length === 0) return { meshes: [], orbits: [] };
  const radius = outer + 0.5;
  const art = (slot: number) => banners[(slot + variety) % banners.length];
  const meshes: Mesh[] = [];
  const side = variety % 2 === 0 ? 1 : -1;

  const front = placeSign(group, radius, art(0), 28, 11, 16.8, bezelMaterial);
  front.rig.rotation.y = entrance;
  meshes.push(...front.meshes);

  const flank = placeSign(group, radius, art(1), 32, 12, 2.2, bezelMaterial);
  flank.rig.rotation.y = entrance + side * 2.05;
  meshes.push(...flank.meshes);

  // One revolution in about forty seconds, neighbouring towers drifting opposite ways.
  const speed = (0.12 + (variety % 3) * 0.025) * (variety % 2 === 0 ? 1 : -1);
  const phase = entrance + variety * 0.85;
  const orbits: HungBanners['orbits'] = [];
  const lane = 58;
  for (const [slot, turn] of [[2, 0], [3, Math.PI]] as const) {
    const picture = art(slot);
    const height = picture.aspect < 1 ? 24 : 10;
    const sign = placeSign(group, radius + 0.15, picture, 24, 10, lane - height / 2, bezelMaterial);
    sign.rig.rotation.y = phase + turn;
    meshes.push(...sign.meshes);
    orbits.push({ rig: sign.rig, speed });
  }
  return { meshes, orbits };
}

export function createTowerShell(
  tower: TowerPlan,
  config: CityConfig,
  materials: CityMaterials,
  interiorLayer: number,
  banners: TowerBanner[] = [],
  variety = 0,
): TowerShell {
  const group = new Group();
  group.name = `tower:${tower.id}`;
  group.position.set(tower.center.x, 0, tower.center.z);
  const outer = config.towerRadius + config.wallThickness;
  const accent = new Color(tower.category.color);

  const makeMaterial = (radius: number, interior: boolean) =>
    new ShaderMaterial({
      vertexShader: shellVertex,
      fragmentShader: shellFragment,
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        uBase: { value: new Color() },
        uLine: { value: new Color() },
        uGlow: { value: new Color() },
        uAccent: { value: accent.clone() },
        uSun: { value: new Vector3(0.45, 0.7, 0.55) },
        uCenter: { value: new Vector2(tower.center.x, tower.center.z) },
        uRadius: { value: radius },
        uFloorHeight: { value: config.floorHeight },
        uBridgeEvery: { value: config.bridgeInterval },
        uTopFloor: { value: tower.floorCount - 1 },
        uInterior: { value: interior ? 1 : 0 },
        uNight: { value: 1 },
        uSignBottom: { value: 0 },
        uSignTop: { value: 0 },
        uOpenings: {
          value: Array.from({ length: MAX_OPENINGS }, (_, i) => {
            const opening = tower.openings[i];
            return opening ? new Vector4(opening.angle, opening.halfSpan / radius, opening.bottom, opening.top) : new Vector4();
          }),
        },
        uOpeningCount: { value: Math.min(MAX_OPENINGS, tower.openings.length) },
      },
      side: interior ? BackSide : FrontSide,
      fog: true,
    });

  const height = config.shellHeight;
  const exteriorMaterial = makeMaterial(outer, false);
  const exterior = new Mesh(new CylinderGeometry(outer, outer, height, 128, 1, true), exteriorMaterial);
  exterior.position.y = height / 2 - 1;
  exterior.frustumCulled = true;
  group.add(exterior);

  const interiorMaterial = makeMaterial(config.towerRadius, true);
  const interior = new Mesh(new CylinderGeometry(config.towerRadius, config.towerRadius, height, 96, 1, true), interiorMaterial);
  interior.position.y = height / 2 - 1;
  interior.visible = false;
  setLayer(interior, interiorLayer);
  group.add(interior);

  // Jambs, lintel and threshold around every opening, through the wall's thickness.
  const frames: BufferGeometry[] = [];
  const colliders: Mesh[] = [];
  const matrix = new Matrix4();
  const mid = config.towerRadius + config.wallThickness / 2;
  const box = (w: number, h: number, d: number, angle: number, along: number, y: number, collide: boolean) => {
    // `along` offsets sideways (tangent to the wall) from the opening's centre.
    const x = Math.sin(angle) * mid + Math.cos(angle) * along;
    const z = Math.cos(angle) * mid - Math.sin(angle) * along;
    const geometry = new BoxGeometry(w, h, d).toNonIndexed();
    geometry.applyMatrix4(matrix.makeRotationY(angle).setPosition(x, y + h / 2, z));
    frames.push(geometry);
    if (collide) {
      const collider = new Mesh(new BoxGeometry(w, h, d));
      collider.visible = false;
      collider.rotation.y = angle;
      collider.position.set(tower.center.x + x, y + h / 2, tower.center.z + z);
      collider.updateMatrixWorld(true);
      colliders.push(collider);
    }
  };
  for (const opening of tower.openings) {
    const bottom = Math.max(0, opening.bottom);
    const h = opening.top - bottom;
    const depth = config.wallThickness + 0.5;
    for (const side of [-1, 1]) box(0.5, h + 0.5, depth, opening.angle, side * (opening.halfSpan + 0.25), bottom, true);
    box(opening.halfSpan * 2 + 1, 0.5, depth, opening.angle, 0, opening.top, false);
  }
  const frameMesh = frames.length ? new Mesh(mergeGeometries(frames), materials.frame) : null;
  for (const geometry of frames) geometry.dispose();
  if (frameMesh) group.add(frameMesh);

  // The outer wall at ground level stops people walking into the tower except through its entrance.
  const entrance = tower.openings[0];
  const gap = (entrance.halfSpan + 0.1) / outer;
  const wallCollider = new Mesh(new CylinderGeometry(outer, outer, 12, 64, 1, true, entrance.angle + gap, Math.PI * 2 - gap * 2));
  wallCollider.visible = false;
  wallCollider.position.set(tower.center.x, 6, tower.center.z);
  wallCollider.updateMatrixWorld(true);
  colliders.push(wallCollider);

  // The tower's name wrapped around it above the entrance, readable across the plaza.
  // Window slits stay out of this band: the name is always here.
  const nameHeight = 5.2;
  const nameBottom = config.entranceHeight + 3.4;
  const nameTop = nameBottom + nameHeight;
  for (const material of [exteriorMaterial, interiorMaterial]) {
    material.uniforms.uSignBottom.value = nameBottom - 0.35;
    material.uniforms.uSignTop.value = nameTop + 0.35;
  }
  const nameTexture = drawBand(
    [
      { text: spaced(tower.category.name), color: '#ffffff', font: `700 150px ${SIGN_FONT}` },
      { text: '●', color: tower.category.color, font: `700 60px ${SIGN_FONT}` },
    ],
    { width: 4096, height: 220, repeat: 3, gap: 90 },
  );
  const nameMaterial = new MeshBasicMaterial({ map: nameTexture, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide });
  const nameRing = new Mesh(new CylinderGeometry(outer + 0.08, outer + 0.08, nameHeight, 128, 1, true), nameMaterial);
  // The first name sits over the entrance.
  nameRing.rotation.y = entrance.angle - Math.PI / 3;
  nameRing.position.y = config.entranceHeight + 3.4 + nameHeight / 2;
  group.add(nameRing);
  const nameTint = (light: boolean) => nameMaterial.color.set(light ? 0x2b2d33 : 0xffffff);

  // Pictures sitting on the outside of the drum: up the front, around the
  // sides, and higher up, the way signs cover a facade. The entrance stays clear.
  const { meshes: bannerMeshes, orbits } = hangBanners(group, outer, entrance.angle, banners, variety, materials.trim);

  const setTheme = (light: boolean) => {
    const palette = PALETTES[light ? 'light' : 'dark'];
    for (const [material, base] of [
      [exteriorMaterial, palette.shell],
      [interiorMaterial, palette.interior],
    ] as const) {
      material.uniforms.uBase.value.set(base);
      material.uniforms.uLine.value.set(palette.shellLine);
      material.uniforms.uGlow.value.set(palette.shellGlow);
      material.uniforms.uNight.value = palette.night;
      material.uniforms.uAccent.value.copy(accent).multiplyScalar(light ? 0.7 : 1);
    }
    nameTint(light);
  };

  return {
    group,
    exterior,
    interior,
    colliders,
    setTheme,
    setInteriorVisible(visible) {
      interior.visible = visible;
    },
    update(dt) {
      for (const orbit of orbits) orbit.rig.rotation.y += orbit.speed * dt;
    },
    dispose() {
      exterior.geometry.dispose();
      exteriorMaterial.dispose();
      interior.geometry.dispose();
      interiorMaterial.dispose();
      frameMesh?.geometry.dispose();
      for (const mesh of bannerMeshes) mesh.geometry.dispose();
      nameRing.geometry.dispose();
      nameMaterial.dispose();
      (nameTexture as Texture).dispose();
      for (const collider of colliders) collider.geometry.dispose();
      group.removeFromParent();
    },
  };
}

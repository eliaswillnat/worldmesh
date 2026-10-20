/**
 * The demo buildings (docs/specs/buildings.md): a handful of themed models,
 * each with a face whose material is named `portal`, written as glTF
 * binaries the way Blender would export them (one primitive per material).
 * The hub shows them on the city's first lots with ?buildings=demo.
 *
 *   node apps/hub/scripts/demo-buildings.mjs
 *
 * Writes apps/hub/public/buildings/*.glb and apps/hub/src/walk/demoBuildings.json
 * (each file's URL and SHA-256, which the hub checks every download against).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Matrix4,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Euler,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../public/buildings');
const LIST = join(here, '../src/walk/demoBuildings.json');

/** A material as glTF has it; colours given in sRGB hex. */
function material(name, color, { metallic = 0, roughness = 0.8, emissive = null } = {}) {
  const linear = (hex) => new Color(hex).convertSRGBToLinear();
  const base = linear(color);
  const glow = emissive ? linear(emissive) : null;
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor: [base.r, base.g, base.b, 1], metallicFactor: metallic, roughnessFactor: roughness },
    ...(glow ? { emissiveFactor: [glow.r, glow.g, glow.b] } : {}),
  };
}

const PORTAL = material('portal', '#7fd8ff', { emissive: '#1a5f7f' });

/** A model being put together: geometry gathered by material. */
class Model {
  constructor(name) {
    this.name = name;
    this.parts = new Map();
  }

  /** Add `geometry` in `mat`, moved to `at`, turned by `turn` (Euler, radians) and scaled by `scale`. */
  add(mat, geometry, at = [0, 0, 0], turn = [0, 0, 0], scale = [1, 1, 1]) {
    const matrix = new Matrix4().compose(new Vector3(...at), new Quaternion().setFromEuler(new Euler(...turn)), new Vector3(...scale));
    const flat = (geometry.index ? geometry.toNonIndexed() : geometry).applyMatrix4(matrix);
    flat.deleteAttribute('uv');
    flat.computeVertexNormals();
    const entry = this.parts.get(mat.name) ?? { mat, geometries: [] };
    entry.geometries.push(flat);
    this.parts.set(mat.name, entry);
    return this;
  }

  box(mat, [w, h, d], [x, y, z]) {
    return this.add(mat, new BoxGeometry(w, h, d), [x, y + h / 2, z]);
  }

  /** The doorway: a w × h face standing on y, its front at z, facing +Z. */
  portal(w, h, z, y = 0) {
    return this.add(PORTAL, new PlaneGeometry(w, h), [0, y + h / 2, z + 0.01]);
  }
}

/** The glTF binary: one node, one mesh, a primitive per material (as Blender exports). */
function glb(model) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const view = (array, target) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    return bufferViews.length - 1;
  };
  const materials = [];
  const primitives = [];
  for (const { mat, geometries } of model.parts.values()) {
    const merged = mergeGeometries(geometries);
    const position = merged.getAttribute('position');
    const normal = merged.getAttribute('normal');
    merged.computeBoundingBox();
    const { min, max } = merged.boundingBox;
    accessors.push({ bufferView: view(position.array, 34962), componentType: 5126, count: position.count, type: 'VEC3', min: min.toArray(), max: max.toArray() });
    accessors.push({ bufferView: view(normal.array, 34962), componentType: 5126, count: normal.count, type: 'VEC3' });
    materials.push(mat);
    primitives.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: materials.length - 1 });
  }
  const json = {
    asset: { version: '2.0', generator: 'WorldMesh demo buildings' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: model.name, mesh: 0 }],
    meshes: [{ name: model.name, primitives }],
    materials,
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

// ── The buildings ─────────────────────────────────────────────────────────────
// Each is drawn at about its real size in metres, front facing +Z. The hub
// scales it to its lot anyway; these just keep the proportions right.

/** A white dome on a drum, an airlock porch in front, a ring of light and a mast. */
function observatory() {
  const white = material('hull', '#eef0f2', { roughness: 0.5 });
  const rust = material('trim', '#c8603a', { roughness: 0.7 });
  const light = material('light', '#9ff3ff', { emissive: '#5fe6ff' });
  const m = new Model('Observatory');
  m.add(white, new CylinderGeometry(6, 6.4, 6, 48), [0, 3, -1.5]);
  m.add(white, new SphereGeometry(6, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), [0, 6, -1.5]);
  m.add(light, new TorusGeometry(6.05, 0.12, 8, 64), [0, 6, -1.5], [Math.PI / 2, 0, 0]);
  m.add(rust, new CylinderGeometry(6.5, 6.5, 0.6, 48), [0, 0.3, -1.5]);
  // The porch: a squat box out of the drum, clear of its curve, the portal on its face.
  m.box(white, [6.2, 6.4, 3.4], [0, 0, 4]);
  m.box(rust, [6.6, 0.5, 3.6], [0, 6.4, 4]);
  m.box(light, [5.4, 0.12, 0.05], [0, 5.7, 5.7]);
  m.portal(4.2, 5.2, 5.7);
  // A mast with a beacon.
  m.add(rust, new CylinderGeometry(0.12, 0.18, 6, 8), [2.8, 13.5, -2.5]);
  m.add(light, new SphereGeometry(0.35, 16, 8), [2.8, 16.6, -2.5]);
  return m;
}

/** Two square towers with battlements either side of an arched gate wall. */
function gatehouse() {
  const stone = material('stone', '#a7a196', { roughness: 0.95 });
  const dark = material('dark stone', '#7c776e', { roughness: 0.95 });
  const roof = material('roof', '#8e3b2e', { roughness: 0.8 });
  const banner = material('banner', '#2f5fb3', { roughness: 0.9 });
  const m = new Model('Gatehouse');
  for (const side of [-1, 1]) {
    const x = side * 4.6;
    m.box(stone, [4, 15, 4.2], [x, 0, -1]);
    m.box(dark, [4.4, 0.6, 4.6], [x, 15, -1]);
    m.add(roof, new ConeGeometry(3.2, 5, 4), [x, 18.1, -1], [0, Math.PI / 4, 0]);
    // Battlements round the tower top.
    for (let i = -1; i <= 1; i += 2) m.box(dark, [0.8, 1, 0.8], [x + i * 1.6, 15.6, 1.1]);
    m.box(banner, [1.4, 4, 0.08], [x, 8, 1.15]);
  }
  // The wall between, with the gate in it.
  m.box(stone, [5.2, 11, 3.6], [0, 0, -1.2]);
  m.box(dark, [5.6, 0.5, 4], [0, 11, -1.2]);
  for (let i = -2; i <= 2; i++) m.box(dark, [0.7, 0.9, 0.7], [i * 1.1, 11.5, 0.4]);
  m.box(dark, [5.4, 0.6, 0.4], [0, 7.6, 0.8]);
  m.portal(4.2, 7.4, 0.6);
  return m;
}

/** A forest lodge: three stacked roofs of warm wood over a lantern-lit porch. */
function lodge() {
  const wood = material('wood', '#8a5a36', { roughness: 0.85 });
  const beam = material('beam', '#4b2f1f', { roughness: 0.85 });
  const moss = material('moss roof', '#46704a', { roughness: 0.9 });
  const lantern = material('lantern', '#ffd27a', { emissive: '#ffb03a' });
  const m = new Model('Forest Lodge');
  m.box(wood, [11, 7, 7], [0, 0, -1.5]);
  // Square pyramids, squashed front to back to match the walls under them.
  m.add(moss, new ConeGeometry(9.2, 3.6, 4).rotateY(Math.PI / 4), [0, 8.8, -1.5], [0, 0, 0], [1, 1, 0.66]);
  m.box(wood, [7, 3.4, 4.6], [0, 9.2, -1.5]);
  m.add(moss, new ConeGeometry(6.2, 3, 4).rotateY(Math.PI / 4), [0, 14, -1.5], [0, 0, 0], [1, 1, 0.7]);
  m.box(wood, [3.6, 2.6, 2.6], [0, 14.2, -1.5]);
  m.add(moss, new ConeGeometry(3.6, 2.8, 4), [0, 18.2, -1.5], [0, Math.PI / 4, 0]);
  // Porch posts and lintel, lanterns either side.
  for (const x of [-3.4, 3.4]) {
    m.box(beam, [0.6, 6, 0.6], [x, 0, 2.4]);
    m.add(lantern, new SphereGeometry(0.35, 12, 8), [x, 4.6, 2.9]);
  }
  m.box(beam, [7.6, 0.7, 0.8], [0, 6, 2.4]);
  m.box(moss, [8.4, 0.4, 4.4], [0, 6.7, 1]);
  m.portal(4.4, 5.6, 2);
  return m;
}

/** A slim night tower stepping back as it rises, banded in neon. */
function neonTower() {
  const glass = material('glass', '#1d2233', { metallic: 0.6, roughness: 0.25 });
  const pink = material('neon pink', '#ff4fd8', { emissive: '#ff2fc8' });
  const cyan = material('neon cyan', '#5ff2ff', { emissive: '#22d8ff' });
  const m = new Model('Neon Tower');
  const tiers = [
    [12, 9, 6.6],
    [9, 9, 5.4],
    [6.4, 8, 4.4],
    [3.6, 6, 3],
  ];
  let y = 0;
  tiers.forEach(([w, h, d], i) => {
    m.box(glass, [w, h, d], [0, y, -d / 2 + 2.6]);
    const neon = i % 2 ? cyan : pink;
    m.box(neon, [w + 0.1, 0.25, d + 0.1], [0, y + h - 0.4, -d / 2 + 2.6]);
    m.box(neon, [0.2, h - 1, 0.1], [w / 2 - 0.4, y + 0.3, 2.62]);
    m.box(neon, [0.2, h - 1, 0.1], [-w / 2 + 0.4, y + 0.3, 2.62]);
    y += h;
  });
  m.add(cyan, new CylinderGeometry(0.08, 0.08, 4, 6), [0, y + 2, 1.1]);
  // A canopy over the entrance.
  m.box(pink, [7, 0.3, 2], [0, 6.4, 3.6]);
  m.portal(5.2, 6, 2.6);
  return m;
}

/** A hangar: a ribbed vault with a wide doorway lit along its edge. */
function hangar() {
  const metal = material('metal', '#9aa3ad', { metallic: 0.7, roughness: 0.4 });
  const rib = material('rib', '#5e6670', { metallic: 0.6, roughness: 0.5 });
  const amber = material('amber', '#ffb347', { emissive: '#ff8a1a' });
  const m = new Model('Hangar');
  // Half a cylinder lying along Z, open side down.
  m.add(metal, new CylinderGeometry(6.4, 6.4, 7, 40, 1, false, -Math.PI / 2, Math.PI), [0, 0, -1], [Math.PI / 2, 0, 0], [1, 1, 1]);
  for (const z of [-4.3, -1, 2.3]) m.add(rib, new TorusGeometry(6.5, 0.22, 8, 40, Math.PI), [0, 0, z]);
  // Its front wall, a half disc, with the portal.
  m.add(metal, new CylinderGeometry(6.4, 6.4, 0.3, 40, 1, false, -Math.PI / 2, Math.PI), [0, 0, 2.5], [Math.PI / 2, 0, 0]);
  m.box(amber, [7.4, 0.2, 0.1], [0, 4.6, 2.72]);
  for (const x of [-3.7, 3.7]) m.box(amber, [0.2, 4.6, 0.1], [x, 0, 2.72]);
  m.portal(7, 4.5, 2.65);
  m.box(rib, [14, 0.4, 8], [0, 0, -1]);
  return m;
}

mkdirSync(OUT, { recursive: true });
const list = [];
for (const [file, build] of [
  ['observatory', observatory],
  ['gatehouse', gatehouse],
  ['lodge', lodge],
  ['neon-tower', neonTower],
  ['hangar', hangar],
]) {
  const data = glb(build());
  writeFileSync(join(OUT, `${file}.glb`), data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  list.push({ modelUrl: `/buildings/${file}.glb`, sha256 });
  console.log(`${file}.glb  ${(data.length / 1024).toFixed(0)} KB  ${sha256}`);
}
writeFileSync(LIST, `${JSON.stringify(list, null, 2)}\n`);

import { Vector3 } from 'three';
import { isPortalName } from './buildingFit';

/**
 * A door drawn on a model in the hub (docs/specs/buildings.md §3.2): a
 * rectangle dragged out on one of its walls, written into the GLB as a
 * two-triangle face with a material named `portal`, the same file a creator
 * would export from Blender. Plain geometry and bytes: no DOM, so the tests
 * read the same rules.
 */

/** A drawn door's corners, counter-clockwise seen from the front: bottom left, bottom right, top right, top left. */
export type DoorCorners = [Vector3, Vector3, Vector3, Vector3];

/** What the drawn face's material is called, and renamed portals become. */
const PORTAL = 'portal';
const FORMER = 'former ';

/**
 * The rectangle dragged from `start` to `end` on the plane through `start`
 * with outward `normal`: its sides run up the plane and level across it, and
 * it stands `lift` in front of the plane so it isn't drawn into the wall.
 */
export function doorCorners(start: Vector3, end: Vector3, normal: Vector3, lift: number): DoorCorners {
  const n = normal.clone().normalize();
  // Up the plane, and to the right as seen from in front of it.
  const up = new Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
  const right = new Vector3().crossVectors(up, n);
  const drag = new Vector3().subVectors(end, start);
  const [left, wide] = [Math.min(0, drag.dot(right)), Math.max(0, drag.dot(right))];
  const [low, high] = [Math.min(0, drag.dot(up)), Math.max(0, drag.dot(up))];
  const at = (across: number, rise: number) => start.clone().addScaledVector(right, across).addScaledVector(up, rise).addScaledVector(n, lift);
  return [at(left, low), at(wide, low), at(wide, high), at(left, high)];
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: object[];
  meshes?: object[];
  materials?: { name?: string }[];
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: object[];
  accessors?: object[];
}

const GLTF = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/**
 * `glb` with a door face at `corners` (in the space of its scene's root),
 * as a node of its own with a material named `portal`. Every other byte of
 * the model is kept; materials that were already portals are renamed
 * (`portal` → `former portal`), so the drawn face is the one door.
 */
export function addDoorToGlb(glb: ArrayBuffer, corners: DoorCorners): ArrayBuffer {
  const view = new DataView(glb);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== GLTF || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== JSON_CHUNK) {
    throw new Error('Not a glTF 2.0 binary (.glb)');
  }
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as GltfJson;
  let at = 20 + jsonLength;
  let bin = new Uint8Array(0);
  if (at + 8 <= glb.byteLength && view.getUint32(at + 4, true) === BIN_CHUNK) {
    bin = new Uint8Array(glb, at + 8, view.getUint32(at, true));
    at += 8 + bin.byteLength;
  }
  // Chunks of other kinds, kept as they were.
  const rest = new Uint8Array(glb, at, Math.max(0, Math.min(view.getUint32(8, true), glb.byteLength) - at));

  json.buffers ??= [];
  if (!json.buffers.length) json.buffers.push({ byteLength: 0 });
  // The GLB's own chunk is always the first buffer; one with an address lives elsewhere.
  if (json.buffers[0].uri !== undefined) throw new Error('Its data is in another file');

  // The face: positions, normals (all one way, out), two triangles.
  const normal = new Vector3().subVectors(corners[1], corners[0]).cross(new Vector3().subVectors(corners[3], corners[0])).normalize();
  const positions = new Float32Array(corners.flatMap((corner) => corner.toArray()));
  const normals = new Float32Array(corners.flatMap(() => normal.toArray()));
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const start = align(bin.byteLength);
  const added = [positions, normals, indices];
  const end = added.reduce((offset, array) => offset + array.byteLength, start);
  const nextBin = new Uint8Array(align(end));
  nextBin.set(bin);
  let offset = start;
  const bufferViews = (json.bufferViews ??= []);
  const views = added.map((array) => {
    nextBin.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength, target: array === indices ? 34963 : 34962 });
    offset += array.byteLength;
    return bufferViews.length - 1;
  });
  json.buffers[0].byteLength = end;

  const accessors = (json.accessors ??= []);
  const low = corners.reduce((min, corner) => min.min(corner), corners[0].clone());
  const high = corners.reduce((max, corner) => max.max(corner), corners[0].clone());
  accessors.push(
    { bufferView: views[0], componentType: 5126, count: 4, type: 'VEC3', min: low.toArray(), max: high.toArray() },
    { bufferView: views[1], componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: views[2], componentType: 5123, count: 6, type: 'SCALAR' },
  );
  const materials = (json.materials ??= []);
  for (const material of materials) if (material.name !== undefined && isPortalName(material.name)) material.name = FORMER + material.name.trim();
  // The hub replaces how it looks; magenta is how a portal face is shown.
  materials.push({ name: PORTAL, pbrMetallicRoughness: { baseColorFactor: [1, 0.24, 0.94, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true } as { name: string });
  const meshes = (json.meshes ??= []);
  meshes.push({ name: 'Door', primitives: [{ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: materials.length - 1 }] });
  const nodes = (json.nodes ??= []);
  nodes.push({ name: 'Door', mesh: meshes.length - 1 });
  const scenes = (json.scenes ??= [{ nodes: [] }]);
  const scene = scenes[json.scene ?? 0];
  if (!scene) throw new Error('It has no scene');
  (scene.nodes ??= []).push(nodes.length - 1);

  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align(text.byteLength);
  const total = 12 + 8 + jsonPadded + 8 + nextBin.byteLength + rest.byteLength;
  const out = new Uint8Array(total);
  const write = new DataView(out.buffer);
  write.setUint32(0, GLTF, true);
  write.setUint32(4, 2, true);
  write.setUint32(8, total, true);
  write.setUint32(12, jsonPadded, true);
  write.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20);
  // JSON is padded with spaces, binary with zeros.
  out.fill(0x20, 20 + text.byteLength, 20 + jsonPadded);
  write.setUint32(20 + jsonPadded, nextBin.byteLength, true);
  write.setUint32(24 + jsonPadded, BIN_CHUNK, true);
  out.set(nextBin, 28 + jsonPadded);
  out.set(rest, 28 + jsonPadded + nextBin.byteLength);
  return out.buffer;
}

function align(bytes: number): number {
  return Math.ceil(bytes / 4) * 4;
}

import { Mesh, Texture, type Group, type Object3D } from 'three';
import { AVENUES, DOOR_OUT } from './avenuePlan';
import { planBuilding, type Lot } from './buildingFit';
import { LOT_FORECOURT, LOT_HEIGHT } from './facade';

/**
 * What a building's GLB may be (docs/specs/buildings.md §3.1), checked the
 * same way wherever one is loaded: in the city before it is shown, and in
 * "My buildings" before it is uploaded.
 */

/** What a building may weigh. */
export const BUILDING_LIMITS = { bytes: 10 * 1024 * 1024, triangles: 150_000, texture: 2048 };
/** Compression these files may not use: each would mean hosting a decoder. */
const REFUSED_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];

/** The GLB's own description of itself: refused before parsing if it needs a decoder. */
export function readGlbJson(buffer: ArrayBuffer): { extensionsUsed?: string[]; extensionsRequired?: string[] } {
  const view = new DataView(buffer);
  // "glTF", version 2, then the first chunk (JSON) length and type.
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) {
    throw new Error('Not a glTF 2.0 binary (.glb)');
  }
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, Math.min(length, buffer.byteLength - 20))));
}

/** SHA-256 of a file, as lower-case hex: what an approval pins (§5.3). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A building's bytes, straight from where it is hosted, no more than the
 * limit; checked against `sha256` when one is given.
 */
export async function downloadBuilding(url: string, sha256?: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('Content-Length') ?? '0') > BUILDING_LIMITS.bytes) throw new Error('Model is over 10 MB');
  const reader = response.body?.getReader();
  let data: Uint8Array;
  if (!reader) {
    data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > BUILDING_LIMITS.bytes) throw new Error('Model is over 10 MB');
  } else {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BUILDING_LIMITS.bytes) {
        await reader.cancel();
        throw new Error('Model is over 10 MB');
      }
      chunks.push(value);
    }
    data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.byteLength;
    }
  }
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  if (sha256 && (await sha256Hex(buffer)) !== sha256.toLowerCase()) throw new Error('Model is not the approved file (hash differs)');
  return buffer;
}

/** The model in a GLB, refused before it is parsed if it needs a decoder buildings may not use. */
export async function parseBuilding(buffer: ArrayBuffer): Promise<Group> {
  const json = readGlbJson(buffer);
  const needs = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])].filter((name) => REFUSED_EXTENSIONS.includes(name));
  if (needs.length) throw new Error(`Uses ${needs[0]}, which buildings may not`);
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

/** Over the triangle or texture limit: refused, after parsing, before it is shown. */
export function checkWeight(object: Object3D): void {
  let triangles = 0;
  let largest = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry;
    triangles += (geometry.index ? geometry.index.count : (geometry.getAttribute('position')?.count ?? 0)) / 3;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      for (const value of Object.values(material)) {
        if (!(value instanceof Texture)) continue;
        const image = value.image as { width?: number; height?: number } | undefined;
        largest = Math.max(largest, image?.width ?? 0, image?.height ?? 0);
      }
    }
  });
  if (triangles > BUILDING_LIMITS.triangles) throw new Error(`${Math.round(triangles)} triangles, over ${BUILDING_LIMITS.triangles}`);
  if (largest > BUILDING_LIMITS.texture) throw new Error(`A ${largest} px texture, over ${BUILDING_LIMITS.texture} px`);
}

/** A world's block, as every lot in the city is today (§2). */
export const BLOCK_LOT: Lot = { width: AVENUES.blockSize, depth: AVENUES.blockSize, forecourt: LOT_FORECOURT, height: LOT_HEIGHT };

/** What the city would make of a building, worked out in the browser before it is uploaded. */
export interface BuildingCheck {
  /** Why it can't be a building, or null. */
  problem: string | null;
  /** The doorway its portal face makes on a block, in metres; null for a standard door at its front. */
  door: { width: number; height: number } | null;
  triangles: number;
  /** It was read and is within the limits, so a door can be drawn on it in the hub. */
  drawable: boolean;
}

/** Every check the city makes before it shows a building, on a file not yet uploaded. */
export async function inspectBuilding(buffer: ArrayBuffer): Promise<BuildingCheck> {
  const refused = (problem: string): BuildingCheck => ({ problem, door: null, triangles: 0, drawable: false });
  if (buffer.byteLength > BUILDING_LIMITS.bytes) return refused('It is over 10 MB.');
  let model: Group;
  try {
    model = await parseBuilding(buffer);
  } catch (error) {
    return refused(error instanceof Error ? `${error.message}.` : 'It could not be read.');
  }
  try {
    checkWeight(model);
    const plan = planBuilding(model, BLOCK_LOT, DOOR_OUT);
    return { problem: plan.problem, door: plan.door, triangles: countTriangles(model), drawable: true };
  } catch (error) {
    return refused(error instanceof Error ? `${error.message}.` : 'It could not be read.');
  } finally {
    model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
        material.dispose();
      }
    });
  }
}

export function countTriangles(object: Object3D): number {
  let triangles = 0;
  object.traverse((child) => {
    if (child instanceof Mesh) triangles += (child.geometry.index?.count ?? child.geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return Math.round(triangles);
}

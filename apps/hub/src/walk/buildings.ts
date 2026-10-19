import { Box3, Group, Matrix4, Mesh, PMREMGenerator, Texture, Vector3, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Door, DoorShape } from './door';
import { LOT_WIDTH } from './facade';
import { findPortalFace, fitToLot, portalTooSmall, portalYaw, taperedReach, type Lot } from './buildingFit';
import demoBuildings from './demoBuildings.json';

/**
 * Buildings in the city (docs/specs/buildings.md): a world's own model
 * standing on its lot in place of the storefront, its portal face the
 * world's door. Models download in this browser, straight from where they
 * are hosted, only near the visitor, and only after passing the limits
 * below. Until one is ready, and whenever one can't be shown, the lot keeps
 * its storefront (the plug avenues.ts builds), so the street never misses
 * a door.
 */

/** Where a building's model is, and the file it must be (§5.3). */
export interface BuildingSource {
  modelUrl: string;
  /** SHA-256 of the approved file, as hex. The building shows only if the download matches. */
  sha256?: string;
}

/** Demo buildings, standing in on the first lots of the city with `?buildings=demo`. */
export const DEMO_BUILDINGS: readonly BuildingSource[] = demoBuildings;

/** What a building may weigh (§3.1). */
export const BUILDING_LIMITS = { bytes: 10 * 1024 * 1024, triangles: 150_000, texture: 2048 };
/** Compression these files may not use: each would mean hosting a decoder. */
const REFUSED_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
/** Load within, unload beyond (metres), at most so many loaded and downloading at once (§7.1). */
export const STREAMING = { load: 90, unload: 140, loaded: 8, downloads: 2 };
/**
 * The lobby is lit for its white walls, about three times as brightly as a
 * model is usually lit for: a building's colours are taken down this much,
 * so they look as their maker meant instead of bleached.
 */
const EXPOSURE = 0.6;
/** How bright the studio metal reflects is, to sit with the lobby's bright light. */
const STUDIO_INTENSITY = 1.6;
/** Seconds a building takes to fade in. */
const FADE_SECONDS = 0.6;
/** How often the streaming looks round, in seconds. */
const LOOK_SECONDS = 0.25;
/** Nobody standing this close in front of the doorway: it doesn't change shape under them. */
const SWAP_CLEAR = 1.5;

/** A lot in the city with a building to stand on it. */
export interface BuildingLot {
  door: Door;
  /** The room round the door (§2). */
  lot: Lot;
  /** How far in front of the wall line the door stands. */
  out: number;
  /** The storefront filling the lot until the building shows, and its collider. */
  plug: { meshes: Object3D[]; collider: Mesh };
  source: BuildingSource;
}

type Status = 'idle' | 'loading' | 'ready' | 'shown' | 'failed';

interface LotState extends BuildingLot {
  status: Status;
  /** The building, placed in the door's frame; in the scene once shown. */
  object: Group | null;
  /** The doorway its portal face makes, or null for the standard door. */
  shape: DoorShape | null;
  abort: AbortController | null;
  /** Seconds since it was shown, while it fades in. */
  shownFor: number;
  fading: Array<{ material: Material; opacity: number; transparent: boolean; depthWrite: boolean }>;
}

export class Buildings {
  private lots: LotState[] = [];
  private enabled: boolean;
  private sinceLook = LOOK_SECONDS;
  private disposed = false;
  /**
   * A soft studio for metal to reflect: the lobby has no environment of its
   * own, and metal with nothing to reflect renders black. Only buildings'
   * metallic materials get it. Made on first need.
   */
  private studio: Texture | null = null;

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
    enabled = true,
  ) {
    this.enabled = enabled;
  }

  /** The city was laid out afresh: these are its lots now. Buildings on the old ones come down. */
  setLots(lots: BuildingLot[]): void {
    for (const lot of this.lots) this.unload(lot);
    this.lots = lots.map((lot) => ({ ...lot, status: 'idle', object: null, shape: null, abort: null, shownFor: 0, fading: [] }));
    this.sinceLook = LOOK_SECONDS;
  }

  /** Private mode loads no buildings: fetching one tells its host who is walking by (§8). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const lot of this.lots) this.unload(lot);
    this.sinceLook = LOOK_SECONDS;
  }

  /** What stops walkers on the lots: each storefront until its building shows. */
  colliders(): Mesh[] {
    return this.lots.filter((lot) => lot.status !== 'shown').map((lot) => lot.plug.collider);
  }

  /** Each frame, with where the visitor stands. */
  update(dt: number, x: number, z: number): void {
    for (const lot of this.lots) if (lot.status === 'shown' && lot.fading.length) this.fade(lot, dt);
    this.sinceLook += dt;
    if (this.sinceLook < LOOK_SECONDS) return;
    this.sinceLook = 0;
    if (!this.enabled) return;

    const distance = (lot: LotState) => Math.hypot(lot.door.group.position.x - x, lot.door.group.position.z - z);
    const byDistance = [...this.lots].sort((a, b) => distance(a) - distance(b));
    // Keep what is in reach, nearest first, up to the budget; let the rest go.
    let kept = 0;
    for (const lot of byDistance) {
      if (lot.status === 'idle' || lot.status === 'failed') continue;
      if (distance(lot) > STREAMING.unload || kept >= STREAMING.loaded) this.unload(lot);
      else kept++;
    }
    let downloading = this.lots.filter((lot) => lot.status === 'loading').length;
    for (const lot of byDistance) {
      if (distance(lot) > STREAMING.load || kept >= STREAMING.loaded) break;
      if (lot.status !== 'idle' || downloading >= STREAMING.downloads) continue;
      kept++;
      downloading++;
      void this.load(lot);
    }
    for (const lot of this.lots) {
      if (lot.status !== 'ready') continue;
      const front = lot.door.distanceInFront(x, z);
      if (front === null || front > SWAP_CLEAR) this.show(lot);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const lot of this.lots) this.unload(lot);
    this.lots = [];
    this.studio?.dispose();
    this.studio = null;
  }

  private environment(): Texture {
    if (!this.studio) {
      const pmrem = new PMREMGenerator(this.renderer);
      this.studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    return this.studio;
  }

  private async load(lot: LotState): Promise<void> {
    lot.status = 'loading';
    const abort = new AbortController();
    lot.abort = abort;
    try {
      const data = await download(lot.source, abort.signal);
      const object = await parse(data);
      if (abort.signal.aborted || this.disposed) {
        disposeObject(object);
        return;
      }
      checkWeight(object);
      this.place(lot, object);
      lot.status = 'ready';
    } catch (error) {
      if (abort.signal.aborted) return;
      lot.status = 'failed';
      console.warn(`[buildings] ${lot.source.modelUrl} keeps its storefront:`, error instanceof Error ? error.message : error);
    } finally {
      if (lot.abort === abort) lot.abort = null;
    }
  }

  /** Turn, scale and move the model onto its lot, round its door (§6). */
  private place(lot: LotState, model: Object3D): void {
    const search = findPortalFace(model);
    if (search.problem) throw new Error(search.problem);
    const yaw = search.face ? portalYaw(search.face) : 0;
    const turn = new Matrix4().makeRotationY(yaw);
    const turned = new Group();
    turned.rotation.y = yaw;
    turned.add(model);
    const bounds = new Box3().setFromObject(turned, true);
    const anchor = search.face
      ? search.face.center.clone().setY(search.face.center.y - search.face.height / 2).applyMatrix4(turn)
      : new Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, bounds.max.z);
    const reach = taperedReach(turned, anchor, lot.lot.taper);
    turned.remove(model);
    const fit = fitToLot(bounds, anchor, lot.lot, lot.out, reach);
    if (search.face) {
      const small = portalTooSmall(search.face, fit.scale);
      if (small) throw new Error(small);
      lot.shape = { width: search.face.width * fit.scale, height: search.face.height * fit.scale, span: LOT_WIDTH };
    }
    // The door takes the portal face's place.
    for (const mesh of search.meshes) mesh.visible = false;
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        const lit = material as Material & { color?: { multiplyScalar(k: number): void }; metalness?: number; envMap?: Texture | null; envMapIntensity?: number };
        // Metal's colour tints what it reflects, not the lobby's lights: it keeps its colour, in step with how metallic it is.
        const metal = lit.metalness ?? 0;
        lit.color?.multiplyScalar(EXPOSURE + (1 - EXPOSURE) * metal);
        if (metal && !lit.envMap) {
          lit.envMap = this.environment();
          lit.envMapIntensity = STUDIO_INTENSITY;
        }
      }
    });
    const holder = new Group();
    holder.name = 'building';
    holder.matrixAutoUpdate = false;
    lot.door.group.updateMatrixWorld();
    holder.matrix.copy(lot.door.group.matrixWorld).multiply(fit.matrix).multiply(turn);
    holder.add(model);
    holder.updateMatrixWorld(true);
    lot.object = holder;
  }

  private show(lot: LotState): void {
    if (!lot.object) return;
    lot.status = 'shown';
    for (const mesh of lot.plug.meshes) mesh.visible = false;
    lot.door.setShape(lot.shape);
    lot.door.hideSign(true);
    lot.fading = [];
    lot.object.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        lot.fading.push({ material, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
        material.transparent = true;
        material.depthWrite = false;
        material.opacity = 0;
        material.needsUpdate = true;
      }
    });
    lot.shownFor = 0;
    this.scene.add(lot.object);
  }

  private fade(lot: LotState, dt: number): void {
    lot.shownFor += dt;
    const t = Math.min(1, lot.shownFor / FADE_SECONDS);
    for (const entry of lot.fading) entry.material.opacity = entry.opacity * t * t * (3 - 2 * t);
    if (t < 1) return;
    for (const { material, opacity, transparent, depthWrite } of lot.fading) {
      Object.assign(material, { opacity, transparent, depthWrite });
      material.needsUpdate = true;
    }
    lot.fading = [];
  }

  /** Back to the storefront, and the model let go. A failed lot stays failed for the visit. */
  private unload(lot: LotState): void {
    lot.abort?.abort();
    lot.abort = null;
    if (lot.status === 'shown') {
      lot.door.setShape(null);
      lot.door.hideSign(false);
      for (const mesh of lot.plug.meshes) mesh.visible = true;
    }
    if (lot.object) {
      lot.object.removeFromParent();
      disposeObject(lot.object, this.studio);
      lot.object = null;
    }
    lot.shape = null;
    lot.fading = [];
    if (lot.status !== 'failed') lot.status = 'idle';
  }
}

/** The model's bytes, no more than the limit, checked against its hash when one was given. */
async function download(source: BuildingSource, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(source.modelUrl, { signal, credentials: 'omit' });
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
  if (source.sha256) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== source.sha256.toLowerCase()) throw new Error('Model is not the approved file (hash differs)');
  }
  return buffer;
}

/** The GLB's own description of itself: refused before parsing if it needs a decoder. */
function readGlbJson(buffer: ArrayBuffer): { extensionsUsed?: string[]; extensionsRequired?: string[] } {
  const view = new DataView(buffer);
  // "glTF", version 2, then the first chunk (JSON) length and type.
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) {
    throw new Error('Not a glTF 2.0 binary (.glb)');
  }
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, Math.min(length, buffer.byteLength - 20))));
}

async function parse(buffer: ArrayBuffer): Promise<Group> {
  const json = readGlbJson(buffer);
  const needs = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])].filter((name) => REFUSED_EXTENSIONS.includes(name));
  if (needs.length) throw new Error(`Uses ${needs[0]}, which buildings may not`);
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

/** Over the triangle or texture limit: refused, after parsing, before it is shown. */
function checkWeight(object: Object3D): void {
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

/** Let go of a model's geometry, materials and textures; `keep` is shared, and stays. */
function disposeObject(object: Object3D, keep: Texture | null = null): void {
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      for (const value of Object.values(material)) if (value instanceof Texture && value !== keep) value.dispose();
      material.dispose();
    }
  });
}

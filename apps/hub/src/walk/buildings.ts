import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Texture,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Door, DoorShape } from './door';
import { prismRoof, prismWalls } from './avenues';
import { planBuilding, type Lot } from './buildingFit';
import { checkWeight, downloadBuilding, parseBuilding, sha256Hex } from './buildingModel';
import demoBuildings from './demoBuildings.json';

/**
 * Buildings in the city (docs/specs/buildings.md): a world's own model
 * standing in place of its block, its portal face the world's door. Models
 * download in this browser, straight from where they are hosted, only near
 * the visitor, and only after passing the limits below. Until one is ready,
 * and whenever one can't be shown, the world keeps its default block
 * (avenues.ts builds it on its own for this), so the street never misses a
 * door.
 */

/** Where a building's model is, and the file it must be (§5.3). */
export interface BuildingSource {
  /** Where to download it. A world's approved building is resolved through the directory instead, just before. */
  modelUrl?: string;
  /** SHA-256 of the approved file, as hex. The building shows only if the download matches. */
  sha256?: string;
  /** The world (its canonical URL) whose approved building this is. */
  world?: string;
}

/** A world's approved building, as the directory resolves it. */
export interface ResolvedBuilding {
  modelUrl: string;
  /** Unix ms when `modelUrl` stops working, or null. */
  expiresAt: number | null;
  sha256: string;
}

/** Where worlds' approved buildings are downloaded from (§7.2; ./buildingDirectory.ts on the hub). */
export interface BuildingDirectory {
  /** Each world (canonical URL) with an approved building, and the SHA-256 its file must have. */
  approved(): Promise<Map<string, string>>;
  /** Where to download these worlds' buildings now. Worlds without one are missing from the answer. */
  resolve(worlds: string[]): Promise<Map<string, ResolvedBuilding>>;
}

/** Demo buildings, standing in on the first lots of the city with `?buildings=demo`. */
export const DEMO_BUILDINGS: readonly BuildingSource[] = demoBuildings;

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
/** Worlds resolved per call, at most (workers/auth MAX_RESOLVE). */
const RESOLVE_BATCH = 16;
/** A resolved download link is used only while it has this long left (ms). */
const LINK_MARGIN_MS = 30_000;
/**
 * Downloaded buildings stay in the browser's Cache Storage under their hash
 * (§7.1), so a second visit downloads nothing; this many at most, oldest
 * dropped first. Nothing is cached by WorldMesh.
 */
const CACHE_NAME = 'worldmesh-buildings-v1';
const CACHE_KEEP = 24;

/** A world's block in the city, with a building to take its place. */
export interface BuildingLot {
  door: Door;
  /** The room round the door: the whole block (§2). */
  lot: Lot;
  /** How far in front of the wall line the door stands. */
  out: number;
  /** The default block, shown until the building is, and its collider. */
  block: { meshes: Object3D[]; collider: Mesh };
  source: BuildingSource;
}

type Status = 'idle' | 'loading' | 'ready' | 'shown' | 'failed';

interface LotState extends BuildingLot {
  status: Status;
  /** Whether this browser already holds the file, by its hash. */
  cache: 'unknown' | 'checking' | 'hit' | 'miss';
  /** Where the directory said to download it, for a world's building. */
  resolved: ResolvedBuilding | null;
  /** The building, placed in the door's frame; in the scene once shown. */
  object: Group | null;
  /** The doorway its portal face makes, or null for the standard door. */
  shape: DoorShape | null;
  /** What stops walkers at the building: its footprint, from the wall line back. */
  collider: Mesh | null;
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
  private colliderMaterial = new MeshBasicMaterial({ visible: false });
  /** A call to the directory is out: one at a time. */
  private resolving = false;

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
    enabled = true,
    private directory: BuildingDirectory | null = null,
    /** What stops walkers changed (a block gave way to its building, or came back): collision has to look again. */
    private onCollidersChange: () => void = () => {},
  ) {
    this.enabled = enabled;
  }

  /** The city was laid out afresh: these are its lots now. Buildings on the old ones come down. */
  setLots(lots: BuildingLot[]): void {
    for (const lot of this.lots) this.unload(lot);
    this.lots = lots.map((lot) => ({
      ...lot,
      status: 'idle',
      cache: lot.source.sha256 ? 'unknown' : 'miss',
      resolved: null,
      object: null,
      shape: null,
      collider: null,
      abort: null,
      shownFor: 0,
      fading: [],
    }));
    this.sinceLook = LOOK_SECONDS;
  }

  /** Private mode loads no buildings: fetching one tells its host who is walking by (§8). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const lot of this.lots) this.unload(lot);
    this.sinceLook = LOOK_SECONDS;
  }

  /** What stops walkers on the lots: each default block until its building shows, then the building. */
  colliders(): Mesh[] {
    return this.lots.flatMap((lot) => (lot.status !== 'shown' ? [lot.block.collider] : lot.collider ? [lot.collider] : []));
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
    const near = byDistance.filter((lot) => distance(lot) <= STREAMING.load);
    // Ahead of loading: which files this browser has already, and where to download the rest.
    for (const lot of near) if (lot.status === 'idle' && lot.cache === 'unknown') void this.checkCache(lot);
    this.resolveSome(near.filter((lot) => lot.status === 'idle' && lot.cache === 'miss' && !lot.source.modelUrl && !fresh(lot.resolved)));
    let downloading = this.lots.filter((lot) => lot.status === 'loading').length;
    for (const lot of near) {
      if (kept >= STREAMING.loaded) break;
      if (lot.status !== 'idle' || downloading >= STREAMING.downloads || !canLoad(lot)) continue;
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
    this.colliderMaterial.dispose();
  }

  private environment(): Texture {
    if (!this.studio) {
      const pmrem = new PMREMGenerator(this.renderer);
      this.studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    return this.studio;
  }

  private async checkCache(lot: LotState): Promise<void> {
    lot.cache = 'checking';
    lot.cache = (await cached(lot.source.sha256!)) ? 'hit' : 'miss';
  }

  /** Asks the directory where to download these worlds' buildings, nearest first, one call at a time. */
  private resolveSome(lots: LotState[]): void {
    const asking = lots.filter((lot) => lot.source.world).slice(0, RESOLVE_BATCH);
    if (this.resolving || !asking.length) return;
    if (!this.directory) {
      for (const lot of asking) lot.status = 'failed';
      return;
    }
    this.resolving = true;
    this.directory
      .resolve(asking.map((lot) => lot.source.world!))
      .then((found) => {
        for (const lot of asking) {
          const building = found.get(lot.source.world!);
          // No longer approved, or a different file than the city was told: the block stays.
          if (building && building.sha256 === lot.source.sha256) lot.resolved = building;
          else if (lot.status === 'idle') lot.status = 'failed';
        }
      })
      .catch((error: unknown) => {
        console.warn('[buildings] could not resolve buildings:', error instanceof Error ? error.message : error);
        for (const lot of asking) if (lot.status === 'idle') lot.status = 'failed';
      })
      .finally(() => {
        this.resolving = false;
      });
  }

  private async load(lot: LotState): Promise<void> {
    lot.status = 'loading';
    const abort = new AbortController();
    lot.abort = abort;
    const label = lot.source.world ?? lot.source.modelUrl;
    try {
      const sha256 = lot.source.sha256;
      let data = lot.cache === 'hit' && sha256 ? await cached(sha256, true) : null;
      if (!data) {
        const url = lot.source.modelUrl ?? (fresh(lot.resolved) ? lot.resolved!.modelUrl : null);
        if (!url) {
          // Gone from this browser's cache after all: back in line, to be resolved first.
          lot.cache = 'miss';
          lot.status = 'idle';
          return;
        }
        data = await downloadBuilding(url, sha256, abort.signal);
        if (sha256) lot.cache = (await keep(sha256, data)) ? 'hit' : 'miss';
      }
      const object = await parseBuilding(data);
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
      console.warn(`[buildings] ${label} keeps its storefront:`, error instanceof Error ? error.message : error);
    } finally {
      if (lot.abort === abort) lot.abort = null;
    }
  }

  /** Turn, scale and move the model onto its lot, round its door (§6). */
  private place(lot: LotState, model: Object3D): void {
    const plan = planBuilding(model, lot.lot, lot.out);
    if (plan.problem) throw new Error(plan.problem);
    const { fit, turn, bounds } = plan;
    if (plan.door) lot.shape = { ...plan.door, span: plan.door.width + 0.4 };
    // The door takes the portal face's place.
    for (const mesh of plan.portalMeshes) mesh.visible = false;
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
    lot.collider = this.footprint(lot, bounds.clone().applyMatrix4(fit.matrix));
  }

  /**
   * A solid box round the building, from the wall line back, as the block's
   * walls were: walkers reach its door as they reached the storefront's,
   * and go no further. `placed` is the fitted model's box, in its door's
   * frame. What stands in the forecourt is not solid.
   */
  private footprint(lot: LotState, placed: Box3): Mesh | null {
    const { width, depth, height } = lot.lot;
    const left = Math.max(placed.min.x, -width / 2);
    const right = Math.min(placed.max.x, width / 2);
    const back = Math.max(placed.min.z, -(depth + lot.out));
    const front = -lot.out;
    const top = Math.min(placed.max.y, height);
    if (right - left < 0.1 || front - back < 0.1 || top < 0.1) return null;
    const outline: Array<[number, number]> = [
      [left, back],
      [right, back],
      [right, front],
      [left, front],
    ];
    const parts = [prismWalls(outline, 0, top), prismRoof(outline, top)];
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    geometry.applyMatrix4(lot.door.group.matrixWorld);
    const collider = new Mesh(geometry, this.colliderMaterial);
    collider.updateMatrixWorld(true);
    return collider;
  }

  private show(lot: LotState): void {
    if (!lot.object) return;
    lot.status = 'shown';
    for (const mesh of lot.block.meshes) mesh.visible = false;
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
    this.onCollidersChange();
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
    const wasShown = lot.status === 'shown';
    if (wasShown) {
      lot.door.setShape(null);
      lot.door.hideSign(false);
      for (const mesh of lot.block.meshes) mesh.visible = true;
    }
    lot.collider?.geometry.dispose();
    lot.collider = null;
    if (lot.object) {
      lot.object.removeFromParent();
      disposeObject(lot.object, this.studio);
      lot.object = null;
    }
    lot.shape = null;
    lot.fading = [];
    if (lot.status !== 'failed') lot.status = 'idle';
    if (wasShown) this.onCollidersChange();
  }
}

/** Whether a lot can start loading: its file is in this browser, or there is a link to download it from. */
function canLoad(lot: LotState): boolean {
  if (lot.cache === 'unknown' || lot.cache === 'checking') return false;
  return lot.cache === 'hit' || !!lot.source.modelUrl || fresh(lot.resolved);
}

/** A resolved download link with time left to use it. */
function fresh(resolved: ResolvedBuilding | null): boolean {
  return !!resolved && (resolved.expiresAt === null || resolved.expiresAt - LINK_MARGIN_MS > Date.now());
}

async function buildingCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    // Storage blocked (private windows, some embedded browsers): download every time.
    return null;
  }
}

const cacheKey = (sha256: string) => new URL(`/__buildings/${sha256}.glb`, location.href).toString();

/** Whether this browser holds the file with this hash; with `read`, its bytes, checked again. */
async function cached(sha256: string, read: true): Promise<ArrayBuffer | null>;
async function cached(sha256: string): Promise<boolean>;
async function cached(sha256: string, read = false): Promise<ArrayBuffer | boolean | null> {
  try {
    const response = await (await buildingCache())?.match(cacheKey(sha256));
    if (!read) return !!response;
    if (!response) return null;
    const data = await response.arrayBuffer();
    return (await sha256Hex(data)) === sha256.toLowerCase() ? data : null;
  } catch {
    return read ? null : false;
  }
}

/** Keeps a checked file for next time, letting the oldest go past CACHE_KEEP. */
async function keep(sha256: string, data: ArrayBuffer): Promise<boolean> {
  try {
    const cache = await buildingCache();
    if (!cache) return false;
    await cache.put(cacheKey(sha256), new Response(data, { headers: { 'Content-Type': 'model/gltf-binary' } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_KEEP))) await cache.delete(old);
    return true;
  } catch {
    return false;
  }
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

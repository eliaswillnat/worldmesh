import { DOOR_VIEW_DEPTH_FAR, DOOR_VIEW_DEPTH_NEAR, DOOR_VIEW_VERSION } from '@worldmesh/runtime';
import type { CubeTexture, Object3D, WebGLRenderer } from 'three';
import { loadCoverTexture, type Door } from './door';
import { canMakeDoorViewCubes, makeDoorViewCubes } from './doorViewCube';

/**
 * Door views: up close, a door stops showing its world's cover and shows the
 * world itself, from a 360° colour + depth snapshot of its spawn point that
 * workers/screenshot takes. Near things slide against far ones as people walk
 * past, so the doorway reads as a window rather than a poster.
 *
 * Snapshots are big (with 1024 px faces, about 25 MB of colour and 12 MB of
 * depth on the GPU), so only the nearest few doors hold one, and each is
 * freed again once its door is out of range.
 */

export interface LoadedDoorView {
  color: CubeTexture;
  /** Distance from the spawn point in metres, in the red channel. */
  depth: CubeTexture;
  /** Spawn eye height above the ground, read from the snapshot's own depth; null if unreadable. */
  eyeHeight: number | null;
  /** Free both cube maps. */
  dispose(): void;
}

interface DoorViewStatus {
  state: string;
  view?: { version?: number; color?: string; depth?: string; faceSize?: number; depthFaceSize?: number };
}

/** Start loading a door's view this close (metres from its doorway). */
const PRELOAD = 24;
/** Fade it in this close, and back out past HIDE. */
const SHOW = 15;
const HIDE = 18;
/** Doors that hold a view at once. Each costs about 37 MB of GPU memory. */
const MAX_HELD = 3;

/** Matches doorViewSlug in workers/screenshot. */
export function doorViewSlug(worldUrl: string): string | null {
  try {
    const url = new URL(worldUrl);
    return `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

export class DoorViewManager {
  /** Per world URL: what the screenshot worker has for it. Asked once per visit. */
  private statuses = new Map<string, Promise<DoorViewStatus | null>>();
  private loading = new Set<Door>();
  /** Worlds with no door view to show (none taken yet, or it would not load). */
  private unavailable = new Set<string>();
  private showing = new Set<Door>();
  private disposed = false;

  /** `endpoint` is workers/screenshot; null turns door views off, as does a renderer that can't hold them. */
  constructor(
    private endpoint: string | null,
    private renderer: WebGLRenderer,
  ) {
    if (!canMakeDoorViewCubes(renderer)) this.endpoint = null;
  }

  /**
   * Every frame: hand views to the nearest doors, fade them by distance, and
   * take them back from doors that are out of range once they have faded.
   */
  update(dt: number, doors: Iterable<Door>, x: number, y: number, z: number, camera: Object3D): void {
    if (!this.endpoint || this.disposed) return;
    const inRange: Array<{ door: Door; distance: number }> = [];
    const all: Door[] = [];
    for (const door of doors) {
      if (!door.world || door.random || door.empty) continue;
      all.push(door);
      if (Math.abs(y - door.group.position.y) > 1) continue;
      const front = door.inFront(0);
      const distance = Math.hypot(x - front.x, z - front.z);
      if (distance < PRELOAD) inRange.push({ door, distance });
    }
    inRange.sort((a, b) => a.distance - b.distance);
    const wanted = new Map(inRange.slice(0, MAX_HELD).map(({ door, distance }) => [door, distance]));

    for (const door of all) {
      const distance = wanted.get(door);
      if (distance === undefined) {
        this.showing.delete(door);
        door.stepView(dt, camera, false);
        // Faded out and out of range: free its textures.
        if (door.doorView && !door.viewVisible) door.setDoorView(null);
        continue;
      }
      if (!door.doorView && !this.loading.has(door) && !this.unavailable.has(door.world!.url)) void this.load(door);
      if (distance < SHOW) this.showing.add(door);
      else if (distance > HIDE) this.showing.delete(door);
      door.stepView(dt, camera, this.showing.has(door));
    }
    // Doors the lobby has since taken down.
    for (const door of this.showing) if (!all.includes(door)) this.showing.delete(door);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async load(door: Door): Promise<void> {
    const url = door.world?.url;
    if (!url) return;
    this.loading.add(door);
    try {
      // A recapture in progress still lists the last good view.
      const view = (await this.status(url))?.view;
      if (!view?.color || !view.depth || view.version !== DOOR_VIEW_VERSION) {
        this.unavailable.add(url);
        return;
      }
      const [color, depth] = await Promise.all([loadCoverTexture(view.color), loadCoverTexture(view.depth, true)]);
      const image = depth?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
      const depthFaceSize = view.depthFaceSize ?? (image ? image.height / 2 : 0);
      if (!color || !depth || !image || this.disposed || image.width !== depthFaceSize * 3 || image.height !== depthFaceSize * 2) {
        color?.dispose();
        depth?.dispose();
        if (!this.disposed) this.unavailable.add(url);
        return;
      }
      const faceSize = view.faceSize ?? (color.image as { height: number }).height / 2;
      const cubes = makeDoorViewCubes(this.renderer, color, depth, faceSize, depthFaceSize);
      const eyeHeight = readEyeHeight(image, depthFaceSize);
      color.dispose();
      depth.dispose();
      door.setDoorView({ color: cubes.color, depth: cubes.depth, eyeHeight, dispose: cubes.dispose });
    } finally {
      this.loading.delete(door);
    }
  }

  private status(worldUrl: string): Promise<DoorViewStatus | null> {
    let status = this.statuses.get(worldUrl);
    if (!status) {
      const slug = doorViewSlug(worldUrl);
      status = slug
        ? fetch(`${this.endpoint!.replace(/\/$/, '')}/door-views/${slug}`)
            .then((response) => (response.ok ? (response.json() as Promise<DoorViewStatus>) : null))
            .catch(() => null)
        : Promise.resolve(null);
      this.statuses.set(worldUrl, status);
    }
    return status;
  }
}

/**
 * The spawn's eye height: the distance straight down, at the middle of the
 * downward face (face 3: column 0, row 1). Puts the world's ground level with
 * the lobby floor. Null if it is not a plausible standing height.
 */
function readEyeHeight(image: CanvasImageSource, faceSize: number): number | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, Math.floor(faceSize / 2), Math.floor(faceSize * 1.5), 1, 1, 0, 0, 1, 1);
  const [r, g] = ctx.getImageData(0, 0, 1, 1).data;
  const q = (r * 256 + g) / 65535;
  const eyeHeight = DOOR_VIEW_DEPTH_NEAR * Math.exp(q * Math.log(DOOR_VIEW_DEPTH_FAR / DOOR_VIEW_DEPTH_NEAR));
  return eyeHeight > 0.3 && eyeHeight < 5 ? eyeHeight : null;
}

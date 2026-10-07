import { DOOR_VIEW_DEPTH_FAR, DOOR_VIEW_DEPTH_NEAR, DOOR_VIEW_VERSION } from '@worldmesh/runtime';
import { CanvasTexture, NearestFilter, NoColorSpace, type Object3D, type Texture } from 'three';
import { loadCoverTexture, type Door } from './door';

/**
 * Door views: up close, a door stops showing its world's cover and shows the
 * world itself, from a 360° colour + depth snapshot of its spawn point that
 * workers/screenshot takes. Near things slide against far ones as people walk
 * past, so the doorway reads as a window rather than a poster.
 *
 * Snapshots are big (a 3072×2048 colour atlas is about 25 MB on the GPU), so
 * only the nearest few doors hold one, and each is freed again once its door
 * is out of range.
 */

export interface LoadedDoorView {
  color: Texture;
  depth: Texture;
  faceSize: number;
  depthFaceSize: number;
  /** Spawn eye height above the ground, read from the snapshot's own depth; null if unreadable. */
  eyeHeight: number | null;
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
/** Doors that hold a view at once. Each costs about 30 MB of GPU memory. */
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

  /** `endpoint` is workers/screenshot; null turns door views off. */
  constructor(private endpoint: string | null) {}

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
      if (!color || !depth || this.disposed) {
        color?.dispose();
        depth?.dispose();
        if (!this.disposed) this.unavailable.add(url);
        return;
      }
      const depthFaceSize = view.depthFaceSize ?? (depth.image as { height: number }).height / 2;
      const prepared = prepareDepth(depth.image as CanvasImageSource & { width: number; height: number }, depthFaceSize);
      depth.dispose();
      if (!prepared) {
        color.dispose();
        this.unavailable.add(url);
        return;
      }
      door.setDoorView({
        color,
        depth: prepared.texture,
        faceSize: view.faceSize ?? (color.image as { height: number }).height / 2,
        depthFaceSize,
        eyeHeight: prepared.eyeHeight,
      });
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
 * Ready the depth atlas for drawing. Near things grow by one pixel, so the
 * soft edge pixels of the colour image (part object, part background) move
 * with the object instead of staying behind as a ghost outline. Each face is
 * filtered on its own so faces do not bleed into each other.
 *
 * Also reads the spawn's eye height: the distance straight down, at the
 * middle of the downward face (face 3: column 0, row 1), which puts the
 * world's ground level with the lobby floor.
 */
function prepareDepth(
  image: CanvasImageSource & { width: number; height: number },
  faceSize: number,
): { texture: Texture; eyeHeight: number | null } | null {
  const { width, height } = image;
  if (width !== faceSize * 3 || height !== faceSize * 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const source = ctx.getImageData(0, 0, width, height);
  const out = ctx.createImageData(width, height);
  const src = source.data;
  const dst = out.data;
  const at = (x: number, y: number) => (y * width + x) * 4;
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y / faceSize) * faceSize;
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x / faceSize) * faceSize;
      let best = 65535;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy;
        if (sy < top || sy >= top + faceSize) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          if (sx < left || sx >= left + faceSize) continue;
          const i = at(sx, sy);
          const q = src[i] * 256 + src[i + 1];
          if (q < best) best = q;
        }
      }
      const o = at(x, y);
      dst[o] = best >> 8;
      dst[o + 1] = best & 255;
      dst[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);

  const down = at(Math.floor(faceSize / 2), Math.floor(faceSize * 1.5));
  const q = (src[down] * 256 + src[down + 1]) / 65535;
  const eyeHeight = DOOR_VIEW_DEPTH_NEAR * Math.exp(q * Math.log(DOOR_VIEW_DEPTH_FAR / DOOR_VIEW_DEPTH_NEAR));

  const texture = new CanvasTexture(canvas);
  // Read as exact numbers: no colour conversion, no blending between texels.
  texture.colorSpace = NoColorSpace;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  return { texture, eyeHeight: eyeHeight > 0.3 && eyeHeight < 5 ? eyeHeight : null };
}

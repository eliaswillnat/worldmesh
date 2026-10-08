import {
  DOOR_VIEW_DEPTH_FAR,
  DOOR_VIEW_DEPTH_NEAR,
  DOOR_VIEW_VERSION,
  PORTAL_SCENE_VERSION,
  type PortalScene,
} from '@worldmesh/runtime';
import {
  Color,
  Plane,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type CubeTexture,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { DOOR_HEIGHT, DOOR_WIDTH, loadCoverTexture, type Door } from './door';
import { canMakeDoorViewCubes, makeDoorViewCubes } from './doorViewCube';
import { loadPortal, type LoadedPortal } from './portalScene';

/**
 * Door views: up close, a door stops showing its world's cover and shows the
 * world itself, from a 360° colour + depth snapshot of its spawn point that
 * workers/screenshot takes. Near things slide against far ones as people walk
 * past, so the doorway reads as a window rather than a poster.
 *
 * Worlds that ship a portal scene do better: their own meshes, drawn live
 * from the visitor's camera every frame (renderPortals), over a backdrop for
 * the far distance. Nothing is guessed, so nothing smears.
 *
 * Both are big (a backdrop or colour cube is about 25 MB on the GPU, plus 12 MB
 * of depth or up to about 18 MB of frame to draw a portal into), so only the
 * nearest doors hold one, and each is freed again once its door is out of range.
 */

export interface LoadedDoorView {
  /** The door view's colour, or a portal scene's backdrop. */
  color: CubeTexture;
  /** Distance from the spawn point in metres, in the red channel; null for a portal scene. */
  depth: CubeTexture | null;
  /** The world drawn live through the doorway, when it has a portal scene. */
  portal: LoadedPortal | null;
  /** Spawn eye height above the ground, read from the snapshot's own depth; null if unreadable. */
  eyeHeight: number | null;
  /** Free both cube maps. */
  dispose(): void;
}

interface DoorViewStatus {
  state: string;
  view?: { version?: number; color?: string; depth?: string; faceSize?: number; depthFaceSize?: number; portal?: PortalScene };
}

/** Start loading a door's view this close (metres from its doorway). */
const PRELOAD = 24;
/** Fade it in this close, and back out past HIDE. */
const SHOW = 15;
const HIDE = 18;
/** Doors that hold a view at once: each costs about 37 MB of GPU memory, and a portal scene is drawn again every frame. */
const MAX_HELD = 2;
/** Pixels of a portal frame per CSS pixel: sharp enough under the doorway's glass, far cheaper than the full screen on phones. */
const PORTAL_RESOLUTION = 1;
/** Longest side of a portal frame, in pixels; big screens draw it a little softer instead of filling memory. */
const PORTAL_MAX_SIDE = 1280;
const CLEAR = new Color(0x000000);

/**
 * How a door shows its world up close. 'best' is the normal choice: the
 * portal scene, else the door view, else the cover.
 */
export type DoorStyle = 'best' | 'cover' | 'cubemap' | 'depth' | 'portal' | 'walk';

/**
 * Compare mode (preview only, VITE_DOOR_COMPARE): each demo world's door
 * shows a different style, so they can be compared side by side.
 */
const COMPARE_STYLES: Record<string, DoorStyle> = {
  city: 'cover',
  medieval: 'cubemap',
  forest: 'depth',
  mars: 'portal',
  space: 'walk',
};

/** The doorway's corners in its door's own frame, for finding it on screen. */
const DOORWAY_CORNERS: ReadonlyArray<[number, number]> = [
  [-DOOR_WIDTH / 2, 0],
  [DOOR_WIDTH / 2, 0],
  [-DOOR_WIDTH / 2, DOOR_HEIGHT],
  [DOOR_WIDTH / 2, DOOR_HEIGHT],
];

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
  private feet = new Vector3();
  /** Doors whose portal scene shows this frame. */
  private portals: Door[] = [];
  /** Each such door's frame, the size of the screen; drawn only where the doorway is. */
  private frames = new Map<Door, WebGLRenderTarget>();
  private size = new Vector2();
  private plane = new Plane();
  private corner = new Vector3();
  private normal = new Vector3();
  /** Drawn inside one door's portal scene too: the visitor's own figure, part way through it (walkThrough). */
  private guest: { door: Door; object: Object3D } | null = null;

  /**
   * `endpoint` is workers/screenshot; null turns door views off, as does a
   * renderer that can't hold them. `compare` gives each demo world's door a
   * different style.
   */
  constructor(
    private endpoint: string | null,
    private renderer: WebGLRenderer,
    private compare = false,
  ) {
    if (!canMakeDoorViewCubes(renderer)) this.endpoint = null;
    // Portal scenes cast shadows. Nothing in them moves, so each is drawn once
    // (renderPortals asks for it); the lobby itself has no shadow-casting lights.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
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
      if (!door.world || door.random || door.empty || this.style(door) === 'cover') continue;
      all.push(door);
      if (Math.abs(y - door.group.position.y) > 1) continue;
      const front = door.inFront(0);
      const distance = Math.hypot(x - front.x, z - front.z);
      if (distance < PRELOAD) inRange.push({ door, distance });
    }
    inRange.sort((a, b) => a.distance - b.distance);
    this.feet.set(x, y, z);
    const wanted = new Map(inRange.slice(0, MAX_HELD).map(({ door, distance }) => [door, distance]));

    for (const door of all) {
      const distance = wanted.get(door);
      if (distance === undefined) {
        this.showing.delete(door);
        door.stepView(dt, camera, this.feet, false);
        // Faded out and out of range: free its textures.
        if (door.doorView && !door.viewVisible && this.guest?.door !== door) this.release(door);
        continue;
      }
      if (!door.doorView && !this.loading.has(door) && !this.unavailable.has(door.world!.url)) void this.load(door);
      if (distance < SHOW) this.showing.add(door);
      else if (distance > HIDE) this.showing.delete(door);
      door.stepView(dt, camera, this.feet, this.showing.has(door));
    }
    // Doors the lobby has since taken down.
    for (const door of this.showing) if (!all.includes(door)) this.showing.delete(door);
    for (const [door] of this.frames) if (!all.includes(door) || !door.doorView?.portal) this.release(door, false);
    this.portals = all.filter((door) => door.doorView?.portal && door.viewVisible);
  }

  /**
   * Every frame, after update and right before the lobby is drawn: draw each
   * showing portal scene from the lobby camera into its door's frame. Only
   * where the doorway is on screen, and only beyond it: a clipping plane on
   * the doorway keeps the world's own ground and walls out of the hall.
   */
  renderPortals(camera: Camera): void {
    if (!this.portals.length) return;
    const renderer = this.renderer;
    const screen = renderer.getDrawingBufferSize(this.size);
    const scale = Math.min(1, PORTAL_RESOLUTION / renderer.getPixelRatio(), PORTAL_MAX_SIDE / Math.max(screen.x, screen.y));
    const width = Math.max(1, Math.round(screen.x * scale));
    const height = Math.max(1, Math.round(screen.y * scale));
    camera.updateMatrixWorld();

    const target = renderer.getRenderTarget();
    const clipping = renderer.clippingPlanes;
    const clearColor = renderer.getClearColor(new Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(CLEAR, 0);
    try {
      for (const door of this.portals) {
        const portal = door.placedPortal();
        const rect = portal && !renderer.xr.isPresenting ? this.screenRect(door, camera) : null;
        if (!portal || !rect) {
          door.setPortalFrame(null, screen.x, screen.y);
          continue;
        }
        let frame = this.frames.get(door);
        if (!frame) {
          // sRGB storage: 8 bits a channel without banding in the dark, multisampled for clean edges.
          frame = new WebGLRenderTarget(width, height, { samples: 4 });
          frame.texture.colorSpace = SRGBColorSpace;
          this.frames.set(door, frame);
        } else if (frame.width !== width || frame.height !== height) {
          frame.setSize(width, height);
        }
        // Rect from normalised device coordinates to the frame's pixels, a pixel wider all round.
        const x0 = Math.max(0, Math.floor(((rect[0] + 1) / 2) * width) - 1);
        const y0 = Math.max(0, Math.floor(((rect[1] + 1) / 2) * height) - 1);
        const x1 = Math.min(width, Math.ceil(((rect[2] + 1) / 2) * width) + 1);
        const y1 = Math.min(height, Math.ceil(((rect[3] + 1) / 2) * height) + 1);
        frame.scissor.set(x0, y0, x1 - x0, y1 - y0);
        frame.scissorTest = true;

        // Keep what lies beyond the doorway: its normal points into the world.
        this.normal.set(0, 0, -1).transformDirection(door.group.matrixWorld);
        this.plane.setFromNormalAndCoplanarPoint(this.normal, door.group.getWorldPosition(this.corner));
        renderer.clippingPlanes = [this.plane];
        if (!portal.shadowsDrawn) {
          renderer.shadowMap.needsUpdate = true;
          portal.shadowsDrawn = true;
        }
        renderer.setRenderTarget(frame);
        // The visitor's figure, once part of it is through the doorway, is
        // drawn in the world too (lit by its lights); the hall's pass draws the rest.
        const guest = this.guest?.door === door ? this.guest.object : null;
        const home = guest?.parent ?? null;
        if (guest) portal.scene.add(guest);
        try {
          renderer.render(portal.scene, camera);
        } finally {
          if (guest) home ? home.add(guest) : guest.removeFromParent();
        }
        door.setPortalFrame(frame.texture, screen.x, screen.y);
      }
    } finally {
      renderer.setRenderTarget(target);
      renderer.clippingPlanes = clipping;
      renderer.setClearColor(clearColor, clearAlpha);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const frame of this.frames.values()) frame.dispose();
    this.frames.clear();
  }


  /** Also draw `object` inside this door's portal scene, or stop (null). */
  setGuest(door: Door, object: Object3D | null): void {
    if (object) this.guest = { door, object };
    else if (this.guest?.door === door) this.guest = null;
  }

  /** The style a door shows its world in: always 'best' outside compare mode. */
  style(door: Door): DoorStyle {
    if (!this.compare || !door.world) return 'best';
    try {
      // preview-mars.worldmesh.net, mars.worldmesh.net, worldmesh-mars-preview.pages.dev, …
      const host = new URL(door.world.url).hostname;
      const name = Object.keys(COMPARE_STYLES).find((world) => new RegExp(`(^|[.-])${world}([.-]|$)`).test(host));
      return name ? COMPARE_STYLES[name] : 'best';
    } catch {
      return 'best';
    }
  }


  /** Take a door's view back, and its portal frame. */
  private release(door: Door, view = true): void {
    this.frames.get(door)?.dispose();
    this.frames.delete(door);
    if (view) door.setDoorView(null);
    else door.setPortalFrame(null, 1, 1);
  }

  /**
   * Where the doorway is on screen, as [left, bottom, right, top] in
   * normalised device coordinates; null if it is off screen. The whole screen
   * if part of it is behind the camera.
   */
  private screenRect(door: Door, camera: Camera): [number, number, number, number] | null {
    const near = (camera as { near?: number }).near ?? 0.1;
    let left = Infinity;
    let bottom = Infinity;
    let right = -Infinity;
    let top = -Infinity;
    for (const [x, y] of DOORWAY_CORNERS) {
      const corner = this.corner.set(x, y, 0).applyMatrix4(door.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -near) return [-1, -1, 1, 1];
      corner.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, corner.x);
      right = Math.max(right, corner.x);
      bottom = Math.min(bottom, corner.y);
      top = Math.max(top, corner.y);
    }
    if (right < -1 || left > 1 || top < -1 || bottom > 1) return null;
    return [Math.max(-1, left), Math.max(-1, bottom), Math.min(1, right), Math.min(1, top)];
  }

  private async load(door: Door): Promise<void> {
    const url = door.world?.url;
    if (!url) return;
    this.loading.add(door);
    try {
      // A recapture in progress still lists the last good view.
      const view = (await this.status(url))?.view;
      const style = this.style(door);
      const portalAllowed = style === 'best' || style === 'portal' || style === 'walk';
      if (portalAllowed && view?.portal?.version === PORTAL_SCENE_VERSION && (await this.loadPortal(door, view.portal))) return;
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
      door.setViewFlat(style === 'cubemap');
      door.setDoorView({ color: cubes.color, depth: cubes.depth, eyeHeight, portal: null, dispose: cubes.dispose });
    } finally {
      this.loading.delete(door);
    }
  }

  /** Hand a door its portal scene; false if it won't load (the door view is next in line). */
  private async loadPortal(door: Door, info: PortalScene): Promise<boolean> {
    const portal = await loadPortal(info, this.renderer).catch(() => null);
    if (!portal) return false;
    if (this.disposed) {
      portal.dispose();
      return true;
    }
    door.setDoorView({ color: portal.backdrop, depth: null, portal, eyeHeight: portal.eyeHeight, dispose: () => portal.dispose() });
    return true;
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

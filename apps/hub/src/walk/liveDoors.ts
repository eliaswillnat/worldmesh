import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { Door } from './door';
import { DOORWAY_CORNERS } from './doorViews';

/**
 * Live doors: a world whose Doorway file says `"view": true` is drawn in its
 * doorway live, by the world itself, from the visitor's own camera
 * (docs/specs/doorway.md §5). The world runs in a frame under the lobby's
 * canvas and the door leaves its opening clear (Door.setLiveHole), so the
 * world shows through it while anything standing in front of the door still
 * covers it. Every frame the world is sent the camera, relative to the door.
 *
 * A second world running costs about as much as the lobby, so only the
 * nearest live door gets one, it draws only while close and on screen, and
 * only the doorway's part of the screen.
 */

const VIEW_PARAM = 'doorway-view';
/** Load the world this close to its doorway, in metres. */
const PRELOAD = 24;
/** Draw it live this close, and stop again past HIDE. */
const SHOW = 15;
const HIDE = 18;
/** Unload it past this, with no other live door nearer. */
const UNLOAD = 30;
/** A world that hasn't said it's ready by then keeps its cover for the visit. */
const READY_TIMEOUT = 20;
/** Pixels of margin round the doorway's part of the screen. */
const RECT_MARGIN = 2;

interface LiveWorld {
  door: Door;
  frame: HTMLIFrameElement;
  origin: string;
  ready: boolean;
  /** The world has drawn its first frame: the doorway can open onto it. */
  framed: boolean;
  timeout: number;
}

/** Whether the world at `url` draws live doorway views: its Doorway file's `view`. */
async function discoverView(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/.well-known/doorway.json', url), { headers: { Accept: 'application/json' } });
    if (!response.ok) return false;
    const doorway = (await response.json()) as { doorway?: unknown; view?: unknown };
    return doorway.doorway === 1 && doorway.view === true;
  } catch {
    return false;
  }
}

export class LiveDoors {
  private layer: HTMLDivElement;
  private live: LiveWorld | null = null;
  /** Per world URL: whether it draws live views, once known. */
  private known = new Map<string, boolean>();
  private asked = new Set<string>();
  private failed = new Set<string>();
  private showing = false;
  private relative = new Matrix4();
  private position = new Vector3();
  private quaternion = new Quaternion();
  private scale = new Vector3();
  private corner = new Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    // Under the canvas, seen only through a doorway left clear for it.
    this.layer = document.createElement('div');
    this.layer.className = 'door-live';
    this.layer.setAttribute('aria-hidden', 'true');
    canvas.before(this.layer);
    window.addEventListener('message', this.onMessage);
  }

  /**
   * Every frame, with the camera where it will be drawn from: keep the
   * nearest live door's world loaded, and send it the camera while it shows.
   * `enabled` false (VR) closes every live doorway.
   */
  update(doors: Iterable<Door>, camera: PerspectiveCamera, feet: Vector3, enabled: boolean): void {
    let nearest: Door | null = null;
    let best = PRELOAD;
    if (enabled) {
      for (const door of doors) {
        if (!door.world || door.random || door.empty || this.failed.has(door.world.url)) continue;
        if (Math.abs(feet.y - door.group.position.y) > 1) continue;
        const distance = this.distance(door, feet);
        if (distance >= best || !this.isLive(door.world.url)) continue;
        best = distance;
        nearest = door;
      }
    }
    if (this.live && this.live.door !== nearest && (nearest || !enabled || this.distance(this.live.door, feet) > UNLOAD)) this.drop();
    if (!this.live && nearest) this.load(nearest);

    const live = this.live;
    if (!live?.ready) return;
    const distance = this.distance(live.door, feet);
    this.showing = distance < (this.showing ? HIDE : SHOW);
    const rect = this.showing ? this.screenRect(live.door, camera) : null;
    if (!rect) {
      live.door.setLiveHole(false);
      return;
    }
    this.send(live, camera, rect);
    live.door.setLiveHole(live.framed);
  }

  dispose(): void {
    this.drop();
    window.removeEventListener('message', this.onMessage);
    this.layer.remove();
  }

  /** Known to draw live views; asks the world the first time it comes near. */
  private isLive(url: string): boolean {
    const known = this.known.get(url);
    if (known !== undefined) return known;
    if (!this.asked.has(url)) {
      this.asked.add(url);
      void discoverView(url).then((live) => this.known.set(url, live));
    }
    return false;
  }

  private distance(door: Door, feet: Vector3): number {
    const front = door.inFront(0);
    return Math.hypot(feet.x - front.x, feet.z - front.z);
  }

  private load(door: Door): void {
    let src: URL;
    try {
      src = new URL(door.world!.url);
    } catch {
      return;
    }
    src.searchParams.set(VIEW_PARAM, '1');
    const frame = document.createElement('iframe');
    frame.src = src.toString();
    frame.title = door.world!.name;
    frame.tabIndex = -1;
    const live: LiveWorld = { door, frame, origin: src.origin, ready: false, framed: false, timeout: 0 };
    live.timeout = window.setTimeout(() => {
      if (live.ready || this.live !== live) return;
      this.failed.add(door.world!.url);
      this.drop();
    }, READY_TIMEOUT * 1000);
    this.layer.append(frame);
    this.live = live;
    this.showing = false;
  }

  private drop(): void {
    const live = this.live;
    if (!live) return;
    window.clearTimeout(live.timeout);
    live.door.setLiveHole(false);
    live.frame.remove();
    this.live = null;
  }

  /** The camera relative to the doorway (feet at its middle, −Z through it), and where the doorway is on screen. */
  private send(live: LiveWorld, camera: PerspectiveCamera, rect: [number, number, number, number]): void {
    camera.updateMatrixWorld();
    live.door.group.updateWorldMatrix(true, false);
    this.relative.copy(live.door.group.matrixWorld).invert().multiply(camera.matrixWorld);
    this.relative.decompose(this.position, this.quaternion, this.scale);
    live.frame.contentWindow?.postMessage(
      {
        type: 'doorway:view',
        camera: { position: this.position.toArray(), quaternion: this.quaternion.toArray(), fov: camera.fov },
        viewport: { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
        rect,
      },
      live.origin,
    );
  }

  /**
   * Where the doorway is on screen, as [left, top, right, bottom] in CSS
   * pixels from the top left; null if it is off screen. The whole screen if
   * part of it is behind the camera.
   */
  private screenRect(door: Door, camera: PerspectiveCamera): [number, number, number, number] | null {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    let left = Infinity;
    let bottom = Infinity;
    let right = -Infinity;
    let top = -Infinity;
    for (const [x, y] of DOORWAY_CORNERS) {
      const corner = this.corner.set(x, y, 0).applyMatrix4(door.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -camera.near) return [0, 0, width, height];
      corner.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, corner.x);
      right = Math.max(right, corner.x);
      bottom = Math.min(bottom, corner.y);
      top = Math.max(top, corner.y);
    }
    if (right < -1 || left > 1 || top < -1 || bottom > 1) return null;
    return [
      Math.max(0, Math.floor(((left + 1) / 2) * width) - RECT_MARGIN),
      Math.max(0, Math.floor(((1 - top) / 2) * height) - RECT_MARGIN),
      Math.min(width, Math.ceil(((right + 1) / 2) * width) + RECT_MARGIN),
      Math.min(height, Math.ceil(((1 - bottom) / 2) * height) + RECT_MARGIN),
    ];
  }

  private onMessage = (event: MessageEvent): void => {
    const live = this.live;
    if (!live || event.source !== live.frame.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'doorway:view-ready') {
      live.ready = true;
      window.clearTimeout(live.timeout);
    } else if (type === 'doorway:view-frame') {
      live.framed = true;
    }
  };
}

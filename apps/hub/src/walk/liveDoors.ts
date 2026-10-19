import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { Door } from './door';

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
 *
 * A world whose Doorway file also says `"embed": true` can be walked into:
 * the same frame takes over the page (walkThrough, §4).
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
/**
 * Margin round the doorway's part of the screen: pixels, plus a share of its
 * size. The world draws a frame after the lobby, so while the visitor turns
 * the doorway has moved on a little; the margin keeps its edge filled.
 */
const RECT_MARGIN = 4;
const RECT_SLACK = 0.08;

/** The doorway's corners in its door's own frame, for finding it on screen. */
function doorwayCorners(door: Door): Array<[number, number]> {
  const half = door.width / 2;
  return [
    [-half, 0],
    [half, 0],
    [-half, door.height],
    [half, door.height],
  ];
}

export interface LiveWorld {
  door: Door;
  frame: HTMLIFrameElement;
  origin: string;
  ready: boolean;
  /** The world has drawn its first frame: the doorway can open onto it. */
  framed: boolean;
  /** It can be walked into (its Doorway file's `embed`). */
  enterable: boolean;
  timeout: number;
}

/** What the world at `url` can do in a doorway: drawn live (`view`), and walked into (`embed`); null for neither. */
async function discoverView(url: string): Promise<{ enterable: boolean } | null> {
  try {
    const response = await fetch(new URL('/.well-known/doorway.json', url), { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const doorway = (await response.json()) as { doorway?: unknown; view?: unknown; embed?: unknown };
    return doorway.doorway === 1 && doorway.view === true ? { enterable: doorway.embed === true } : null;
  } catch {
    return null;
  }
}

export class LiveDoors {
  private layer: HTMLDivElement;
  private live: LiveWorld | null = null;
  /** Per world URL, once known: what it can do in a doorway, null if not drawn live. */
  private known = new Map<string, { enterable: boolean } | null>();
  /** Being walked into (walkThrough): keep this world whatever else happens. */
  private held = false;
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
   * `enabled` false (VR) closes every live doorway. While held (walked
   * into), its world stays, whatever is nearer.
   */
  update(doors: Iterable<Door>, camera: PerspectiveCamera, feet: Vector3, enabled: boolean): void {
    if (this.held && this.live) {
      const rect = this.screenRect(this.live.door, camera);
      if (rect) this.send(this.live, camera, rect);
      return;
    }
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
    // Walked away, the world keeps drawing while the cover fades back over it.
    const drawn = this.showing || live.door.liveShowing;
    const rect = drawn ? this.screenRect(live.door, camera) : null;
    if (!rect) {
      // Walked away: the cover fades back. Off screen: only paused.
      live.door.setLiveHole(false, this.showing);
      return;
    }
    this.send(live, camera, rect);
    live.door.setLiveHole(this.showing && live.framed);
  }

  /** The live world loaded now, if any. */
  get world(): LiveWorld | null {
    return this.live;
  }

  /** The door's live world is showing, ready, and can be walked into. */
  walkable(door: Door): boolean {
    const live = this.live;
    return !!live && live.door === door && live.ready && live.framed && live.enterable && door.liveShowing;
  }

  /** Keep the live world while it is walked into (or let it go again). */
  hold(held: boolean): void {
    this.held = held;
  }

  /** It took over: the world's frame, in front of everything, is the page now. */
  takeOver(): void {
    const live = this.live;
    if (!live) return;
    this.layer.classList.add('entered');
    this.layer.removeAttribute('aria-hidden');
    live.frame.tabIndex = 0;
    live.frame.focus();
  }

  dispose(): void {
    this.drop();
    window.removeEventListener('message', this.onMessage);
    this.layer.remove();
  }

  /** Known to draw live views; asks the world the first time it comes near. */
  private isLive(url: string): boolean {
    const known = this.known.get(url);
    if (known !== undefined) return known !== null;
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
    // Once walked into, it is the world: its own controls, sound and VR.
    frame.setAttribute('allow', 'autoplay; fullscreen; xr-spatial-tracking; gamepad');
    const enterable = this.known.get(door.world!.url)?.enterable === true;
    const live: LiveWorld = { door, frame, origin: src.origin, ready: false, framed: false, enterable, timeout: 0 };
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
    live.door.dropLive();
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
    for (const [x, y] of doorwayCorners(door)) {
      const corner = this.corner.set(x, y, 0).applyMatrix4(door.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -camera.near) return [0, 0, width, height];
      corner.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, corner.x);
      right = Math.max(right, corner.x);
      bottom = Math.min(bottom, corner.y);
      top = Math.max(top, corner.y);
    }
    if (right < -1 || left > 1 || top < -1 || bottom > 1) return null;
    const margin = RECT_MARGIN + RECT_SLACK * Math.max(((right - left) / 2) * width, ((top - bottom) / 2) * height);
    return [
      Math.max(0, Math.floor(((left + 1) / 2) * width - margin)),
      Math.max(0, Math.floor(((1 - top) / 2) * height - margin)),
      Math.min(width, Math.ceil(((right + 1) / 2) * width + margin)),
      Math.min(height, Math.ceil(((1 - bottom) / 2) * height + margin)),
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

import { Matrix4, Quaternion, Scene, Vector3, type PerspectiveCamera } from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { DOOR_HEIGHT, DOOR_WIDTH, type Door } from './door';
import { DOORWAY_CORNERS } from './doorViews';

/**
 * Live doors: a world whose Doorway file says `"view": true` is shown live in
 * its doorway (docs/specs/doorway.md §3.1). Its page runs in a frame, laid
 * flat in the doorway with CSS 3D under the lobby's canvas, and the door
 * leaves its opening clear (Door.setLiveHole), so the page shows through it
 * while anything standing in front of the door still covers it. The world
 * just runs as it always does: nothing is sent to it, nothing asked of it.
 *
 * A second world running costs about as much as the lobby, so only the
 * nearest live door gets one, shown only while close and on screen.
 */

const VIEW_PARAM = 'doorway-view';
/** Load the world this close to its doorway, in metres. */
const PRELOAD = 24;
/** Show it this close, and hide it again past HIDE. */
const SHOW = 15;
const HIDE = 18;
/** Unload it past this, with no other live door nearer. */
const UNLOAD = 30;
/** The frame's size in CSS pixels: the doorway's proportions, so the world fills it. */
const FRAME_HEIGHT = 640;
const FRAME_WIDTH = Math.round(FRAME_HEIGHT * (DOOR_WIDTH / DOOR_HEIGHT));
/** A little past the doorway's edges, so no seam shows round the opening. */
const BLEED = 1.02;
/** After the page loads, time for the world to draw before the doorway opens onto it. */
const SETTLE = 1500;

interface LiveWorld {
  door: Door;
  object: CSS3DObject;
  /** The world has had time to draw: the doorway can open onto it. */
  framed: boolean;
  timeout: number;
}

/** Whether the world at `url` can be shown live: its Doorway file's `view`. */
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
  private renderer = new CSS3DRenderer();
  private scene = new Scene();
  private live: LiveWorld | null = null;
  /** Per world URL: whether it can be shown live, once known. */
  private known = new Map<string, boolean>();
  private asked = new Set<string>();
  private showing = false;
  /** The frame's place in its door's own frame: centred in the doorway, pixels to metres. */
  private placement = new Matrix4().compose(
    new Vector3(0, DOOR_HEIGHT / 2, -0.02),
    new Quaternion(),
    new Vector3().setScalar((DOOR_WIDTH / FRAME_WIDTH) * BLEED),
  );
  private corner = new Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    // Under the canvas, seen only through a doorway left clear for it.
    this.layer = document.createElement('div');
    this.layer.className = 'door-live';
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.style.visibility = 'hidden';
    this.layer.append(this.renderer.domElement);
    canvas.before(this.layer);
  }

  /**
   * Every frame, with the camera where it will be drawn from: keep the
   * nearest live door's world loaded, and lay it in its doorway while it
   * shows. `enabled` false (VR) closes every live doorway.
   */
  update(doors: Iterable<Door>, camera: PerspectiveCamera, feet: Vector3, enabled: boolean): void {
    let nearest: Door | null = null;
    let best = PRELOAD;
    if (enabled) {
      for (const door of doors) {
        if (!door.world || door.random || door.empty) continue;
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
    if (!live) return;
    const distance = this.distance(live.door, feet);
    this.showing = distance < (this.showing ? HIDE : SHOW) && this.onScreen(live.door, camera);
    const shown = this.showing && live.framed;
    live.door.setLiveHole(shown);
    this.layer.style.visibility = shown ? 'visible' : 'hidden';

    // Placed even while hidden: rendering is what puts the frame in the page, so it loads.
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const size = this.renderer.getSize();
    if (size.width !== width || size.height !== height) this.renderer.setSize(width, height);
    live.door.group.updateWorldMatrix(true, false);
    live.object.matrix.multiplyMatrices(live.door.group.matrixWorld, this.placement);
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.drop();
    this.layer.remove();
  }

  /** Known to be shown live; asks the world the first time it comes near. */
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
    frame.style.width = `${FRAME_WIDTH}px`;
    frame.style.height = `${FRAME_HEIGHT}px`;
    const object = new CSS3DObject(frame);
    frame.style.pointerEvents = 'none';
    object.matrixAutoUpdate = false;
    const live: LiveWorld = { door, object, framed: false, timeout: 0 };
    frame.addEventListener('load', () => {
      live.timeout = window.setTimeout(() => (live.framed = true), SETTLE);
    }, { once: true });
    this.scene.add(object);
    this.live = live;
    this.showing = false;
  }

  private drop(): void {
    const live = this.live;
    if (!live) return;
    window.clearTimeout(live.timeout);
    live.door.setLiveHole(false);
    // Removing the object takes its frame out of the page (CSS3DObject).
    this.scene.remove(live.object);
    this.layer.style.visibility = 'hidden';
    this.live = null;
  }

  /** Whether any of the doorway is on screen; true when part of it is behind the camera. */
  private onScreen(door: Door, camera: PerspectiveCamera): boolean {
    camera.updateMatrixWorld();
    door.group.updateWorldMatrix(true, false);
    let left = Infinity;
    let bottom = Infinity;
    let right = -Infinity;
    let top = -Infinity;
    for (const [x, y] of DOORWAY_CORNERS) {
      const corner = this.corner.set(x, y, 0).applyMatrix4(door.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -camera.near) return true;
      corner.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, corner.x);
      right = Math.max(right, corner.x);
      bottom = Math.min(bottom, corner.y);
      top = Math.max(top, corner.y);
    }
    return !(right < -1 || left > 1 || top < -1 || bottom > 1);
  }
}

import { EMBED_PARAM, type AvatarDescriptor, type PlayerState, type ViewMode } from '@worldmesh/runtime';
import { Matrix3, Matrix4, Quaternion, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { DOOR_HEIGHT, DOOR_WIDTH, type Door } from './door';
import type { DoorViewManager } from './doorViews';

/**
 * Walking through a door into its world, with nothing in between.
 *
 * The door draws the world live from the visitor's camera (its portal scene),
 * and the world itself, the real page, is already loaded behind the hall,
 * waiting offline (EMBED_PARAM). The doorway lets the visitor walk on into
 * the portal scene, their figure drawn in it, and the third-person camera
 * glides in after them (the wall behind a door is too thin for it to trail
 * all the way through). The moment the camera reaches the doorway, so that it
 * fills the screen, the real world is handed the visitor's position, speed,
 * heading and camera in its own coordinates, draws that same view, and takes
 * the lobby's place; its camera eases back out from there. No fade, no load.
 *
 * Only for doors in the 'walk' style (doorViews), whose world can be
 * embedded: a world that never says it is ready is travelled to as usual.
 */

/** Load the world behind the hall once its door is this close (metres from the doorway). */
const PRELOAD = 24;
/** And let it go again past this. */
const UNLOAD = 32;
/** Seconds a world has to say it is ready before its door goes back to travelling the usual way. */
const READY_TIMEOUT = 12;
/** Hand over once the camera is this close to the doorway (metres): it fills the screen by then. */
const CROSS = 0.35;
/** The doorway, a little wider, for "the camera is coming through it". */
const DOORWAY_MARGIN = 0.3;
/** Back out of the doorway by this much (metres in front of it) and it closes behind them again. */
const DISARM = 1.5;
/** However the camera goes, hand over once the visitor is this far through (metres behind the doorway). */
const FAR_ENOUGH = 8;
/** Seconds to wait for the world to draw the hand-over, before travelling to it the usual way. */
const HANDOVER_TIMEOUT = 3;
/** The camera starts gliding in once the visitor is this close in front of the doorway (metres)... */
const GLIDE_FROM = 2;
/** ...and is right behind them by this far through it, before the wall behind the door stops them. */
const GLIDE_TO = -0.55;
/** How far behind the visitor the camera ends up, metres. */
const GLIDE_NEAR = 1;

export interface WalkThroughOptions {
  views: DoorViewManager;
  /** The visitor's figure in the lobby, drawn in the world while part way through. */
  avatar: () => Object3D | null;
  state: () => PlayerState;
  /** The address the lobby would travel to (with `from`, for the way back). */
  travelUrl: (worldUrl: string) => string;
  viewMode: () => ViewMode;
  /** The figure's colour, carried into the world; null keeps the world's own (private mode). */
  color: () => string | null;
  /**
   * The visitor's character (Avatar Wallet) and its model file, as the lobby
   * shows it; null for the default body. Handed to the waiting world as soon
   * as it is ready, so it is loaded long before the doorway.
   */
  character: () => Character | null;
  /** The character's handoff ticket, for the world's portals onwards. */
  characterTicket: () => string | null;
  /** The lobby's third-person camera distance. */
  cameraDistance: { get(): number; set(distance: number): void };
  /** Hand-over started: stop the lobby where it is (its last frame stays up). */
  freeze: () => void;
  /** The world has taken over: leave the lobby's room, remember the way back. */
  entered: (door: Door) => void;
}

export interface Character {
  descriptor: AvatarDescriptor;
  data: ArrayBuffer;
}

interface WaitingWorld {
  door: Door;
  frame: HTMLIFrameElement;
  ready: boolean;
  timeout: number;
  /** The character last handed over (undefined: nothing yet), and whether the world has it on screen. */
  character?: Character | null;
  characterLoaded: boolean;
}

export class WalkThrough {
  private layer: HTMLDivElement;
  private world: WaitingWorld | null = null;
  /** Worlds that never said they were ready: their doors travel the usual way. */
  private failed = new Set<string>();
  /** The door being walked through right now. */
  private armed: Door | null = null;
  private handover: number | null = null;
  private done = false;
  private lastCamera = new Vector3();
  private lastTurn = new Quaternion();
  private haveLast = false;
  private local = new Vector3();
  /** The camera distance before a glide started; null while not gliding. */
  private glideFrom: number | null = null;
  /** Fingers on the screen: a joystick still held when the world takes over keeps them walking. */
  private touches = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private options: WalkThroughOptions,
  ) {
    // Under the canvas: the waiting world is out of sight until it takes over.
    this.layer = document.createElement('div');
    this.layer.className = 'door-world';
    this.layer.setAttribute('aria-hidden', 'true');
    canvas.before(this.layer);
    window.addEventListener('message', this.onMessage);
    window.addEventListener('touchstart', this.onTouches, { capture: true, passive: true });
    window.addEventListener('touchend', this.onTouches, { capture: true, passive: true });
    window.addEventListener('touchcancel', this.onTouches, { capture: true, passive: true });
  }

  /** Every frame, before `step`: keep the nearest walk door's world waiting behind the hall. */
  update(doors: Iterable<Door>, feet: Vector3): void {
    if (this.handover !== null || this.done) return;
    let nearest: Door | null = null;
    let best = PRELOAD;
    let current = Infinity;
    for (const door of doors) {
      if (!door.world || door.random || this.options.views.style(door) !== 'walk') continue;
      if (Math.abs(feet.y - door.group.position.y) > 1) continue;
      const front = door.inFront(0);
      const distance = Math.hypot(feet.x - front.x, feet.z - front.z);
      if (door === this.world?.door) current = distance;
      if (distance < best && !this.failed.has(door.world.url)) {
        best = distance;
        nearest = door;
      }
    }
    if (this.world && this.world.door !== this.armed && (current > UNLOAD || (nearest && nearest !== this.world.door))) this.drop();
    if (nearest && !this.world) this.load(nearest);
    // A character picked (or dropped) while a world waits.
    if (this.world?.ready && this.world.character !== this.options.character()) this.sendCharacter();
  }

  /**
   * The visitor stepped into this doorway. True if they can walk on through it
   * (the lobby must not travel); false to travel the usual way.
   */
  enter(door: Door): boolean {
    if (this.handover !== null || this.done) return true;
    const world = this.world;
    if (!world || world.door !== door || !world.ready || !door.doorView?.portal) return false;
    if (this.armed !== door) {
      this.disarm();
      this.armed = door;
      door.setPassable(true);
      const avatar = this.options.avatar();
      if (avatar) this.options.views.setGuest(door, avatar);
    }
    return true;
  }

  /** Every frame, with the camera where it will be drawn from: hand over once it reaches the doorway. */
  step(camera: PerspectiveCamera, feet: Vector3): void {
    if (this.handover !== null || this.done) return;
    this.glide(feet);
    const door = this.armed;
    if (door) {
      door.group.updateMatrixWorld();
      const along = door.group.worldToLocal(this.local.copy(feet)).z;
      if (along > DISARM) {
        this.disarm();
      } else {
        const eye = door.group.worldToLocal(camera.getWorldPosition(this.local));
        const inDoorway =
          Math.abs(eye.x) < DOOR_WIDTH / 2 + DOORWAY_MARGIN && eye.y > -DOORWAY_MARGIN && eye.y < DOOR_HEIGHT + DOORWAY_MARGIN;
        if ((inDoorway && eye.z < CROSS) || along < -FAR_ENOUGH) {
          this.handOver(door, camera, eye.z < 0);
          return;
        }
      }
    }
    camera.getWorldPosition(this.lastCamera);
    camera.getWorldQuaternion(this.lastTurn);
    this.haveLast = true;
  }

  /**
   * Walking up to a ready door and into it, the third-person camera closes in
   * behind the visitor, so that it comes through the doorway right after them.
   * Back to where it was when they step away.
   */
  private glide(feet: Vector3): void {
    const world = this.world;
    const door = world?.ready && world.door.doorView?.portal && this.options.viewMode() === 'third' ? world.door : null;
    let t = 0;
    if (door) {
      door.group.updateMatrixWorld();
      const local = door.group.worldToLocal(this.local.copy(feet));
      if (Math.abs(local.x) < DOOR_WIDTH / 2 + DOORWAY_MARGIN && local.z < GLIDE_FROM) {
        t = Math.min(1, (GLIDE_FROM - local.z) / (GLIDE_FROM - GLIDE_TO));
      }
    }
    if (t <= 0) {
      if (this.glideFrom !== null) this.options.cameraDistance.set(this.glideFrom);
      this.glideFrom = null;
      return;
    }
    if (this.glideFrom === null) this.glideFrom = this.options.cameraDistance.get();
    const eased = t * t * (3 - 2 * t);
    this.options.cameraDistance.set(this.glideFrom + (GLIDE_NEAR - this.glideFrom) * eased);
  }

  dispose(): void {
    if (this.done) return; // The visitor is in that world now; its page stays.
    window.removeEventListener('message', this.onMessage);
    this.stopTouches();
    if (this.handover !== null) window.clearTimeout(this.handover);
    this.disarm();
    this.drop();
    this.layer.remove();
  }

  /**
   * Hand the visitor to the waiting world: their pose, in its coordinates
   * (the inverse of where the door stood its portal scene). If the camera
   * already went past the doorway this frame, the lobby's last frame is drawn
   * from where it was instead, so it never shows the back of the wall.
   */
  private handOver(door: Door, camera: PerspectiveCamera, crossed: boolean): void {
    const world = this.world;
    const portal = door.doorView?.portal;
    if (!world || !portal || !door.world) return;
    const toWorld = new Matrix4().copy(portal.placement).invert();
    const turn = new Matrix3().setFromMatrix4(toWorld);
    const state = this.options.state();
    const heading = (yaw: number) => {
      const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).applyMatrix3(turn);
      return Math.atan2(-forward.x, -forward.z);
    };
    const pose = {
      position: new Vector3(...state.position).applyMatrix4(toWorld).toArray(),
      velocity: new Vector3(...state.velocity).applyMatrix3(turn).toArray(),
      camera: camera.getWorldPosition(new Vector3()).applyMatrix4(toWorld).toArray(),
      mode: this.options.viewMode(),
      yaw: heading(state.yaw),
      facing: heading(state.facing),
      pitch: state.pitch,
      fov: camera.fov,
      color: this.options.color(),
    };
    if (crossed && this.haveLast) {
      camera.position.copy(this.lastCamera);
      camera.quaternion.copy(this.lastTurn);
      camera.updateMatrixWorld();
    }
    this.options.freeze();
    const url = this.options.travelUrl(door.world.url);
    world.frame.contentWindow?.postMessage({ type: 'worldmesh:enter', url, pose }, new URL(world.frame.src).origin);
    // Never left standing in a frozen hall: travel the usual way if it doesn't answer.
    this.handover = window.setTimeout(() => {
      window.location.href = url;
    }, HANDOVER_TIMEOUT * 1000);
  }

  /** The world drew the hand-over: it takes the lobby's place. */
  private takeOver(): void {
    const world = this.world;
    if (!world || this.done) return;
    this.done = true;
    if (this.handover !== null) window.clearTimeout(this.handover);
    this.handover = null;
    this.layer.classList.add('entered');
    this.layer.removeAttribute('aria-hidden');
    world.frame.tabIndex = 0;
    world.frame.focus();
    document.documentElement.classList.add('world-entered');
    // Back returns to the lobby, which comes back at this door.
    window.history.pushState({ worldmeshEntered: true }, '');
    window.addEventListener('popstate', () => window.location.reload(), { once: true });
    // A finger still on the lobby's joystick can't reach the world's: carry on forward until it lifts.
    if (this.touches > 0) this.carry(-1);
    else this.stopTouches();
    this.options.entered(world.door);
  }

  private carry(z: number): void {
    const frame = this.world?.frame;
    frame?.contentWindow?.postMessage({ type: 'worldmesh:carry', x: 0, z }, new URL(frame.src).origin);
  }

  private onTouches = (event: TouchEvent): void => {
    this.touches = event.touches.length;
    if (this.done && this.touches === 0) {
      this.carry(0);
      this.stopTouches();
    }
  };

  private stopTouches(): void {
    window.removeEventListener('touchstart', this.onTouches, true);
    window.removeEventListener('touchend', this.onTouches, true);
    window.removeEventListener('touchcancel', this.onTouches, true);
  }

  /**
   * The lobby's character to the waiting world: descriptor and the model file
   * the lobby already downloaded (copied across, never fetched again), or
   * null for the default body.
   */
  private sendCharacter(): void {
    const world = this.world;
    if (!world) return;
    const character = this.options.character();
    world.character = character;
    world.characterLoaded = false;
    world.frame.contentWindow?.postMessage(
      {
        type: 'worldmesh:avatar',
        descriptor: character?.descriptor ?? null,
        data: character?.data ?? null,
        ticket: character ? this.options.characterTicket() : null,
      },
      new URL(world.frame.src).origin,
    );
  }

  private onMessage = (event: MessageEvent): void => {
    const world = this.world;
    if (!world || event.source !== world.frame.contentWindow) return;
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === 'worldmesh:ready') {
      world.ready = true;
      window.clearTimeout(world.timeout);
      this.sendCharacter();
    } else if (data?.type === 'worldmesh:avatar-ready') {
      world.characterLoaded = (data as { loaded?: unknown }).loaded === true;
    } else if (data?.type === 'worldmesh:entered' && this.handover !== null) {
      this.takeOver();
    } else if (data?.type === 'worldmesh:navigate' && this.done) {
      // Inside the world, its portals and links leave the hub page.
      if (typeof data.url === 'string' && /^https?:\/\//.test(data.url)) window.location.href = data.url;
    }
  };

  private load(door: Door): void {
    let src: URL;
    try {
      src = new URL(door.world!.url);
    } catch {
      return;
    }
    src.searchParams.set(EMBED_PARAM, '1');
    const frame = document.createElement('iframe');
    frame.src = src.toString();
    frame.title = door.world!.name;
    frame.tabIndex = -1;
    // Once walked into, it is the world: its own controls, sound and VR.
    frame.setAttribute('allow', 'autoplay; fullscreen; xr-spatial-tracking; gamepad');
    const world: WaitingWorld = { door, frame, ready: false, timeout: 0, characterLoaded: false };
    // A preview world behind its Access login never loads in a frame, nor does a world on an older runtime.
    world.timeout = window.setTimeout(() => {
      if (world.ready || this.world !== world) return;
      this.failed.add(door.world!.url);
      this.drop();
    }, READY_TIMEOUT * 1000);
    this.layer.append(frame);
    this.world = world;
  }

  private drop(): void {
    const world = this.world;
    if (!world) return;
    window.clearTimeout(world.timeout);
    world.frame.remove();
    this.world = null;
  }

  private disarm(): void {
    const door = this.armed;
    if (!door) return;
    door.setPassable(false);
    this.options.views.setGuest(door, null);
    this.armed = null;
  }
}

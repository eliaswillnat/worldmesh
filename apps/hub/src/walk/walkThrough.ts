import type { AvatarDescriptor, PlayerState, ViewMode } from '@worldmesh/runtime';
import { Matrix3, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { Door } from './door';
import type { LiveDoors, LiveWorld } from './liveDoors';

/**
 * Walking through a door into its world, with nothing in between.
 *
 * The door shows the world live (liveDoors): the real page, running in a
 * frame under the lobby, drawing itself from the visitor's camera. Walking
 * in, the visitor goes on into the doorway and the third-person camera
 * glides in after them (the wall behind a door is too thin for it to trail
 * all the way through). The moment the camera reaches the doorway, so that it
 * fills the screen, that same world is handed the visitor's position, speed,
 * heading and camera in the door's frame (the frame its views come in), goes
 * online from there and takes the lobby's place. No fade, no load: it was
 * already the picture in the doorway.
 *
 * Only for doors whose world can be walked into (liveDoors.walkable: drawn
 * live, and its Doorway file says `"embed": true`). Any other door travels
 * the usual way.
 */

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
  live: LiveDoors;
  state: () => PlayerState;
  /** The address the lobby would travel to (with `from`, for the way back). */
  travelUrl: (worldUrl: string) => string;
  viewMode: () => ViewMode;
  /** The figure's colour, carried into the world; null keeps the world's own (private mode). */
  color: () => string | null;
  /**
   * The visitor's character (Avatar Wallet) and its model file, as the lobby
   * shows it; null for the default body. Handed to the live world as soon as
   * it is ready, so it is loaded long before the doorway.
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

export class WalkThrough {
  /** The door being walked through right now. */
  private armed: Door | null = null;
  private handover: number | null = null;
  private done = false;
  /** The live world handed over to. */
  private world: LiveWorld | null = null;
  /** Per live world: the character last handed over (undefined: nothing yet). */
  private characters = new WeakMap<LiveWorld, Character | null>();
  private lastCamera = new Vector3();
  private lastTurn = new Quaternion();
  private haveLast = false;
  private local = new Vector3();
  /** The camera distance before a glide started; null while not gliding. */
  private glideFrom: number | null = null;
  /** Fingers on the screen: a joystick still held when the world takes over keeps them walking. */
  private touches = 0;

  constructor(private options: WalkThroughOptions) {
    window.addEventListener('message', this.onMessage);
    window.addEventListener('touchstart', this.onTouches, { capture: true, passive: true });
    window.addEventListener('touchend', this.onTouches, { capture: true, passive: true });
    window.addEventListener('touchcancel', this.onTouches, { capture: true, passive: true });
  }

  /** Every frame, before `step`: hand the visitor's character to a live world that can be walked into. */
  update(): void {
    if (this.handover !== null || this.done) return;
    const world = this.options.live.world;
    if (world?.ready && world.enterable && this.characters.get(world) !== this.options.character()) this.sendCharacter(world);
  }

  /**
   * The visitor stepped into this doorway. True if they can walk on through it
   * (the lobby must not travel); false to travel the usual way.
   */
  enter(door: Door): boolean {
    if (this.handover !== null || this.done) return true;
    // Part way through one door, nothing else may take them: on the far side
    // of the wall stands the back of an outside door.
    if (this.armed && this.armed !== door) return true;
    if (this.armed === door) return true;
    if (!this.options.live.walkable(door)) return false;
    this.armed = door;
    door.setPassable(true);
    this.options.live.hold(true);
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
          Math.abs(eye.x) < door.width / 2 + DOORWAY_MARGIN && eye.y > -DOORWAY_MARGIN && eye.y < door.height + DOORWAY_MARGIN;
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

  dispose(): void {
    if (this.done) return; // The visitor is in that world now; its page stays.
    window.removeEventListener('message', this.onMessage);
    this.stopTouches();
    if (this.handover !== null) window.clearTimeout(this.handover);
    this.disarm();
  }

  /**
   * Walking up to a door that can be walked into, the third-person camera
   * closes in behind the visitor, so that it comes through the doorway right
   * after them. Back to where it was when they step away.
   */
  private glide(feet: Vector3): void {
    const live = this.options.live.world;
    const door = live && this.options.live.walkable(live.door) && this.options.viewMode() === 'third' ? live.door : null;
    let t = 0;
    if (door) {
      door.group.updateMatrixWorld();
      const local = door.group.worldToLocal(this.local.copy(feet));
      if (Math.abs(local.x) < door.width / 2 + DOORWAY_MARGIN && local.z < GLIDE_FROM) {
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

  /**
   * Hand the visitor to the live world: their pose in the door's frame
   * (threshold at the origin, +Y up, −Z through the doorway), the frame its
   * views come in, so it lands them where it drew them. If the camera already
   * went past the doorway this frame, the lobby's last frame is drawn from
   * where it was instead, so it never shows the back of the wall.
   */
  private handOver(door: Door, camera: PerspectiveCamera, crossed: boolean): void {
    const world = this.options.live.world;
    if (!world || world.door !== door || !door.world) return;
    door.group.updateMatrixWorld();
    const toDoor = new Matrix4().copy(door.group.matrixWorld).invert();
    const turn = new Matrix3().setFromMatrix4(toDoor);
    const state = this.options.state();
    const heading = (yaw: number) => {
      const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).applyMatrix3(turn);
      return Math.atan2(-forward.x, -forward.z);
    };
    const pose = {
      position: new Vector3(...state.position).applyMatrix4(toDoor).toArray(),
      velocity: new Vector3(...state.velocity).applyMatrix3(turn).toArray(),
      camera: camera.getWorldPosition(new Vector3()).applyMatrix4(toDoor).toArray(),
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
    this.world = world;
    this.options.freeze();
    const url = this.options.travelUrl(door.world.url);
    world.frame.contentWindow?.postMessage({ type: 'doorway:enter', url, pose }, world.origin);
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
    this.options.live.takeOver();
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
    const world = this.world;
    world?.frame.contentWindow?.postMessage({ type: 'doorway:carry', x: 0, z }, world.origin);
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
   * The lobby's character to the live world (Doorway §6): the model file the
   * lobby already downloaded (copied across, never fetched again), or null
   * for the default body. The Avatar Wallet descriptor and the handoff ticket
   * ride along under `worldmesh`, for WorldMesh worlds.
   */
  private sendCharacter(world: LiveWorld): void {
    const character = this.options.character();
    this.characters.set(world, character);
    world.frame.contentWindow?.postMessage(
      {
        type: 'doorway:character',
        format: character?.descriptor.format ?? null,
        name: character?.descriptor.name ?? null,
        data: character?.data ?? null,
        worldmesh: {
          descriptor: character?.descriptor ?? null,
          ticket: character ? this.options.characterTicket() : null,
        },
      },
      world.origin,
    );
  }

  private onMessage = (event: MessageEvent): void => {
    const world = this.world;
    if (!world || event.source !== world.frame.contentWindow) return;
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === 'doorway:entered' && this.handover !== null) {
      this.takeOver();
    } else if (data?.type === 'doorway:navigate' && this.done) {
      // Inside the world, its portals and links leave the hub page.
      const url = data.url;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) window.location.href = url;
    }
  };

  private disarm(): void {
    const door = this.armed;
    if (!door) return;
    door.setPassable(false);
    this.options.live.hold(false);
    this.armed = null;
  }
}

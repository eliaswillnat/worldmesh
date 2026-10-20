import { Euler, PerspectiveCamera, Quaternion, Vector3, type Camera } from 'three';
import type { CollisionWorld } from '../movement/collision.js';
import type { ViewMode, ViewOptions } from '../types.js';

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.01;
/** The bird's-eye view's fixed tilt: a three-quarter look down, close to isometric but in perspective. */
const AERIAL_PITCH = -0.75;
const AERIAL_MIN_DISTANCE = 12;
const AERIAL_MAX_DISTANCE = 200;
/** The bird's-eye camera never goes higher than this above the ground it looks at, unless the world says otherwise. */
const AERIAL_MAX_HEIGHT = 40;
/** Panning speed, in the bird's-eye camera's distances per second: higher up, faster over the ground. */
const AERIAL_PAN = 0.9;
const AERIAL_PAN_FAST = 2.5;
/** Seconds to swoop between the bird's-eye view and the walking camera. */
const SWOOP = 0.8;
/** A landing point is kept this far back from a wall, on the camera's side. */
const LANDING_STANDOFF = 0.4;
const DOWN = new Vector3(0, -1, 0);

export interface CameraRigOptions extends ViewOptions {
  camera: Camera;
  collision: CollisionWorld;
}

/** The two modes the player walks in; the bird's-eye view always returns to one of them. */
export type WalkingView = Exclude<ViewMode, 'aerial'>;

/**
 * Owns yaw/pitch and all three camera modes. Worlds get first-person,
 * third-person and the bird's-eye view for free, with the same toggle key
 * everywhere, because this lives in the runtime rather than in each world's main.ts.
 */
export class CameraRig {
  yaw: number;
  pitch: number;
  mode: ViewMode;
  distance: number;
  sensitivity: number;
  /** True when the world offers the bird's-eye view. */
  readonly aerialEnabled: boolean;
  /** How far the bird's-eye camera would like to sit from the point it looks at; aerialReach caps it. */
  aerialDistance: number;
  /** The highest the bird's-eye camera goes above the ground it looks at. */
  readonly aerialMaxHeight: number;
  /** The walking mode the bird's-eye view goes back to. */
  walkingMode: WalkingView;
  /**
   * Where the player would land from the bird's-eye view: the first surface
   * under the middle of the screen. Null outside it, or over nothing.
   */
  landing: Vector3 | null = null;

  private camera: Camera;
  private collision: CollisionWorld;
  private minDistance: number;
  private maxDistance: number;
  private euler = new Euler(0, 0, 0, 'YXZ');
  private target = new Vector3();
  private offset = new Vector3();
  /** Smoothed boom length so the camera does not pop when it clears a wall. */
  private currentBoom: number;
  /** After snapBoom: ease back out slowly, a pull-back rather than a jump. */
  private gentle = false;
  /** Bird's-eye pitch, kept apart so the walking camera comes back the way it was. */
  private readonly aerialPitch = AERIAL_PITCH;
  /** Where on screen the bird's-eye view aims (normalized device coordinates); null aims nowhere. */
  private aim: { x: number; y: number } | null = null;
  private origin = new Vector3();
  private ray = new Vector3();
  /** The ground point the bird's-eye camera looks at, moved by panning. */
  private focus = new Vector3();
  private focusSet = false;
  private feet = new Vector3();
  private landingPoint = new Vector3();
  private probe = new Vector3();
  private turn = new Quaternion();
  /** Easing from where the camera was when the mode changed into or out of the bird's-eye view. */
  private swoop: { position: Vector3; quaternion: Quaternion; t: number } | null = null;

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.collision = options.collision;
    this.aerialEnabled = options.aerial === true;
    this.aerialMaxHeight = Math.max(1, options.aerialMaxHeight ?? AERIAL_MAX_HEIGHT);
    const mode = options.mode ?? 'first';
    this.mode = mode === 'aerial' && !this.aerialEnabled ? 'third' : mode;
    this.walkingMode = this.mode === 'aerial' ? 'third' : this.mode;
    this.distance = options.distance ?? 5;
    this.currentBoom = this.distance;
    this.minDistance = options.minDistance ?? 2;
    this.maxDistance = options.maxDistance ?? 12;
    this.aerialDistance = clamp(options.aerialDistance ?? 60, AERIAL_MIN_DISTANCE, AERIAL_MAX_DISTANCE);
    this.sensitivity = options.sensitivity ?? 0.0022;
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? 0;
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    // The bird's-eye view only turns: its tilt stays three-quarter.
    if (this.mode === 'aerial') return;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  zoom(wheel: number): void {
    if (wheel === 0) return;
    if (this.mode === 'aerial') {
      // From the distance actually shown, so zooming in past the height cap responds at once.
      this.aerialDistance = clamp(this.aerialReach * Math.exp(wheel * 0.001), AERIAL_MIN_DISTANCE, AERIAL_MAX_DISTANCE);
      return;
    }
    if (this.mode !== 'third') return;
    this.distance = clamp(this.distance + wheel * 0.01, this.minDistance, this.maxDistance);
  }

  setMode(mode: ViewMode): void {
    if (mode === 'aerial' && !this.aerialEnabled) return;
    const previous = this.mode;
    if (previous === mode) return;
    this.mode = mode;
    if (mode !== 'aerial') this.walkingMode = mode;
    if (mode === 'third') this.currentBoom = this.distance;
    if (mode === 'aerial') {
      // Up over wherever the player stands.
      this.focus.copy(this.feet);
      this.focusSet = true;
    } else {
      this.landing = null;
      this.aim = null;
    }
    // Into or out of the bird's-eye view, the camera swoops instead of cutting.
    if (mode === 'aerial' || previous === 'aerial') {
      this.swoop = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), t: 0 };
    }
  }

  /**
   * How far the bird's-eye camera actually sits from the point it looks at:
   * the distance asked for, pulled in so the camera stays within
   * aerialMaxHeight of the ground at the current tilt.
   */
  get aerialReach(): number {
    const height = Math.max(AERIAL_MIN_DISTANCE, this.aerialMaxHeight / Math.sin(-this.aerialPitch));
    return Math.min(this.aerialDistance, height);
  }

  /** The mode V goes to next: first ↔ third. From the bird's-eye view, back to walking. */
  nextMode(): ViewMode {
    if (this.mode === 'aerial') return this.walkingMode;
    return this.mode === 'first' ? 'third' : 'first';
  }

  /** Put the third-person camera this far back right now; it eases back to `distance` from there. */
  snapBoom(length: number): void {
    this.currentBoom = clamp(length, 0.4, this.maxDistance);
    this.gentle = true;
  }

  toggleMode(): ViewMode {
    this.setMode(this.nextMode());
    return this.mode;
  }

  /**
   * Slide the bird's-eye view over the ground. `x`/`z` are the move axes
   * (−z forward), turned by the camera's yaw; `fast` while sprint is held.
   */
  pan(x: number, z: number, dt: number, fast = false): void {
    if (this.mode !== 'aerial' || (x === 0 && z === 0)) return;
    const speed = this.aerialReach * AERIAL_PAN * (fast ? AERIAL_PAN_FAST : 1) * dt;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.focus.x += (x * cos + z * sin) * speed;
    this.focus.z += (z * cos - x * sin) * speed;
  }

  /**
   * Slide the bird's-eye view by a drag of `dx`/`dy` CSS pixels on a view
   * `viewHeight` pixels tall, so the ground under the finger or cursor
   * follows it.
   */
  drag(dx: number, dy: number, viewHeight: number): void {
    if (this.mode !== 'aerial' || (dx === 0 && dy === 0) || viewHeight <= 0) return;
    const fov = this.camera instanceof PerspectiveCamera ? this.camera.fov : 60;
    const perPixel = (2 * this.aerialReach * Math.tan(((fov / 2) * Math.PI) / 180)) / viewHeight;
    // Up and down the screen covers more ground: the floor is seen at a slant.
    const right = -dx * perPixel;
    const back = -dy * perPixel / Math.sin(-this.aerialPitch);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.focus.x += right * cos + back * sin;
    this.focus.z += back * cos - right * sin;
  }

  /** Aim the bird's-eye view at a point on screen (normalized device coordinates), or nowhere. */
  aimAt(x: number, y: number): void;
  aimAt(point: null): void;
  aimAt(x: number | null, y = 0): void {
    this.aim = x === null ? null : { x, y };
  }

  /** Point the camera at the player. `feet` is the player's base position. */
  update(dt: number, feet: Vector3, eyeHeight: number): void {
    this.feet.copy(feet);
    if (this.mode === 'aerial') {
      this.updateAerial();
    } else {
      this.updateWalking(dt, feet, eyeHeight);
    }
    if (this.swoop) {
      const swoop = this.swoop;
      swoop.t = Math.min(1, swoop.t + dt / SWOOP);
      const k = swoop.t * swoop.t * (3 - 2 * swoop.t);
      this.camera.position.lerpVectors(swoop.position, this.camera.position, k);
      this.turn.copy(this.camera.quaternion);
      this.camera.quaternion.slerpQuaternions(swoop.quaternion, this.turn, k);
      if (swoop.t >= 1) this.swoop = null;
    }
  }

  private updateWalking(dt: number, feet: Vector3, eyeHeight: number): void {
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.target.set(feet.x, feet.y + eyeHeight, feet.z);

    if (this.mode === 'first') {
      this.camera.position.copy(this.target);
      this.currentBoom = this.distance;
      return;
    }

    // Boom backwards along the view direction, pulled in by anything in the way.
    this.offset.set(0, 0, 1).applyQuaternion(this.camera.quaternion);
    const wanted = this.collision.castDistance(this.target, this.offset, this.distance + 0.3) - 0.3;
    const boom = clamp(wanted, 0.4, this.distance);
    // Snap in fast, ease out slowly: popping into geometry is worse than lag.
    const rate = boom < this.currentBoom ? 1 : 1 - Math.exp(-(this.gentle ? 1.6 : 8) * dt);
    this.currentBoom += (boom - this.currentBoom) * rate;
    if (this.gentle && (boom < this.currentBoom || this.currentBoom > boom - 0.05)) this.gentle = false;
    this.camera.position.copy(this.target).addScaledVector(this.offset, this.currentBoom);
  }

  /**
   * High above the focus, looking down at it at a three-quarter angle. The
   * focus stays at the height the view opened at (the player's feet), so
   * panning glides at one height instead of bobbing up over every roof.
   */
  private updateAerial(): void {
    if (!this.focusSet) {
      this.focus.copy(this.feet);
      this.focusSet = true;
    }
    const reach = this.aerialReach;

    this.euler.set(this.aerialPitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.offset.set(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.focus).addScaledVector(this.offset, reach);
    this.camera.updateMatrixWorld();
    this.landing = this.aim ? this.landingAt(this.aim.x, this.aim.y) : null;
  }

  /**
   * What a point on screen (normalized device coordinates) points at from
   * the bird's-eye view: along that line of sight to the first thing it
   * meets, then straight down from just in front of it to a floor, so
   * pointing at a wall lands at its foot, not inside it. Null over nothing.
   */
  landingAt(x: number, y: number): Vector3 | null {
    if (this.mode !== 'aerial') return null;
    const position = this.origin.setFromMatrixPosition(this.camera.matrixWorld);
    const direction = this.ray.set(x, y, 0.5).unproject(this.camera).sub(position).normalize();
    if (this.collision.isEmpty) {
      // No colliders: the world is a flat floor at its ground level.
      if (direction.y >= 0) return null;
      const along = (this.collision.groundLevel - position.y) / direction.y;
      return this.landingPoint.copy(position).addScaledVector(direction, along);
    }
    const reach = this.aerialReach * 4;
    const hit = this.collision.castLandable(position, direction, reach);
    if (!hit) return null;
    const along = Math.max(0, hit.distanceTo(position) - LANDING_STANDOFF);
    this.probe.copy(position).addScaledVector(direction, along);
    const ground = this.groundUnder(this.probe.x, this.probe.z, this.probe.y + 0.5, reach);
    if (ground === null) return null;
    return this.landingPoint.set(this.probe.x, ground, this.probe.z);
  }

  /** The highest surface under x/z that can be landed on, looking down from `top` as far as `depth`; null over nothing. */
  private groundUnder(x: number, z: number, top: number, depth: number): number | null {
    if (this.collision.isEmpty) return this.collision.groundLevel;
    this.probe.set(x, top, z);
    return this.collision.castLandable(this.probe, DOWN, depth)?.y ?? null;
  }

  /** Horizontal forward vector, for spawn orientation helpers. */
  getForward(out = new Vector3()): Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  resize(width: number, height: number): void {
    if (this.camera instanceof PerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

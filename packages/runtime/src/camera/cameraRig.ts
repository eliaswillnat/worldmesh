import { Euler, PerspectiveCamera, Vector3, type Camera } from 'three';
import type { CollisionWorld } from '../movement/collision.js';
import type { ViewMode, ViewOptions } from '../types.js';

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.01;

export interface CameraRigOptions extends ViewOptions {
  camera: Camera;
  collision: CollisionWorld;
}

/**
 * Owns yaw/pitch and both camera modes. Worlds get first- and third-person
 * for free, with the same toggle key everywhere, because this lives in the
 * runtime rather than in each world's main.ts.
 */
export class CameraRig {
  yaw: number;
  pitch: number;
  mode: ViewMode;
  distance: number;
  sensitivity: number;

  private camera: Camera;
  private collision: CollisionWorld;
  private minDistance: number;
  private maxDistance: number;
  private euler = new Euler(0, 0, 0, 'YXZ');
  private target = new Vector3();
  private offset = new Vector3();
  /** Smoothed boom length so the camera does not pop when it clears a wall. */
  private currentBoom: number;

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.collision = options.collision;
    this.mode = options.mode ?? 'first';
    this.distance = options.distance ?? 5;
    this.currentBoom = this.distance;
    this.minDistance = options.minDistance ?? 2;
    this.maxDistance = options.maxDistance ?? 12;
    this.sensitivity = options.sensitivity ?? 0.0022;
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? 0;
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  zoom(wheel: number): void {
    if (this.mode !== 'third' || wheel === 0) return;
    this.distance = clamp(this.distance + wheel * 0.01, this.minDistance, this.maxDistance);
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    if (mode === 'third') this.currentBoom = this.distance;
  }

  toggleMode(): ViewMode {
    this.setMode(this.mode === 'first' ? 'third' : 'first');
    return this.mode;
  }

  /** Point the camera at the player. `feet` is the player's base position. */
  update(dt: number, feet: Vector3, eyeHeight: number): void {
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
    const rate = boom < this.currentBoom ? 1 : 1 - Math.exp(-8 * dt);
    this.currentBoom += (boom - this.currentBoom) * rate;
    this.camera.position.copy(this.target).addScaledVector(this.offset, this.currentBoom);
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

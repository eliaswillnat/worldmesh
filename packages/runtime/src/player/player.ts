import { Group, MathUtils, Mesh, Object3D, Vector3 } from 'three';
import type { LoadedAvatar } from '../avatar/loader.js';
import type { PlayerOptions } from '../types.js';
import { setFigureStroke } from './stroke.js';
import {
  animateDefaultAvatar,
  createDefaultAvatar,
  setAvatarExpression,
  type AvatarExpression,
  type AvatarMotion,
} from './avatar.js';

/** Flying at full speed leans the body this far into the direction of travel, in radians. */
const FLY_PITCH = 0.6;
const FLY_ROLL = 0.45;
/** Horizontal speed that gets that lean, in m/s (the default fly speed). Fast flying leans further, up to half again. */
const FLY_LEAN_SPEED = 12;
const FLY_LEAN_MAX = 1.5;

export interface PlayerAvatarOptions extends PlayerOptions {
  height: number;
  radius: number;
}

/**
 * The visible body. It is a plain Object3D so a world can swap in its own
 * model, and so a future multiplayer layer can instantiate the same avatar
 * for remote peers without touching movement code.
 */
export class Player {
  readonly root: Group | null;
  readonly height: number;
  readonly radius: number;
  readonly eyeHeight: number;

  /** Tracked even for custom avatars, so worlds and peers can react to it. */
  expression: AvatarExpression = 'smile';
  /** Where the body faces. In third person it follows movement, not the camera. */
  facing = 0;

  private isDefaultAvatar: boolean;
  /** The body the world started with, kept aside while an external avatar is shown. */
  private baseBody: Object3D | null = null;
  private external: LoadedAvatar | null = null;
  /** Current flying lean: forward (pitch) and sideways (roll), eased. */
  private leanPitch = 0;
  private leanRoll = 0;
  private pivot = new Vector3();
  private turned = new Vector3();

  constructor(options: PlayerAvatarOptions) {
    this.height = options.height;
    this.radius = options.radius;
    this.eyeHeight = options.eyeHeight ?? options.height - 0.22;

    if (options.avatar === false) {
      this.root = null;
      this.isDefaultAvatar = false;
      return;
    }

    this.root = new Group();
    this.root.name = 'worldmesh:player';
    // Turn to face first, then lean in the body's own frame.
    this.root.rotation.order = 'YXZ';
    this.isDefaultAvatar = !options.avatar;

    const body = options.avatar ?? createDefaultAvatar(options.height);
    // The default figure always wears its ink outline, in the hub and every world alike.
    if (this.isDefaultAvatar) setFigureStroke(body, true);
    this.root.add(body as Object3D);
    this.baseBody = body;
  }

  /** Whether an external avatar (e.g. from the visitor's Avatar Wallet) is shown. */
  get hasExternalBody(): boolean {
    return !!this.external;
  }

  /**
   * Show an external avatar instead of the world's body. The original body is
   * kept, so `clearExternalBody()` brings it back. Ignored when the world
   * turned the avatar off (`avatar: false`).
   */
  setExternalBody(avatar: LoadedAvatar): boolean {
    if (!this.root || !this.baseBody) {
      avatar.dispose();
      return false;
    }
    this.clearExternalBody();
    this.baseBody.visible = false;
    this.root.scale.y = 1;
    this.root.add(avatar.object);
    this.external = avatar;
    return true;
  }

  clearExternalBody(): void {
    if (!this.external) return;
    this.external.object.removeFromParent();
    this.external.dispose();
    this.external = null;
    if (this.baseBody) this.baseBody.visible = true;
  }

  /**
   * Place the avatar at the player's feet, facing `yaw`, and animate it for `motion`.
   * Says whether a foot landed this frame, or null when the avatar's walk is
   * not one the runtime animates and so cannot tell.
   */
  sync(feet: Vector3, yaw: number, currentHeight: number, motion?: AvatarMotion, freeLook = false): boolean | null {
    if (!freeLook) this.facing = yaw;
    else if (motion && motion.speed > 0.3 && motion.heading !== undefined) {
      let delta = motion.heading - this.facing;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.facing += delta * (1 - Math.exp(-12 * motion.dt));
    }
    if (!this.root) return null;
    this.root.rotation.y = this.facing;
    this.lean(motion, currentHeight);
    // Lean about the middle of the body, not the feet, so the head does not swing out.
    this.pivot.set(0, currentHeight / 2, 0);
    this.turned.copy(this.pivot).applyEuler(this.root.rotation);
    this.root.position.copy(feet).add(this.pivot).sub(this.turned);
    if (this.external) {
      if (motion) this.external.animate(motion);
      return null;
    } else if (this.isDefaultAvatar) {
      // Squash the default body while crouching instead of rebuilding it.
      this.root.scale.y = currentHeight / this.height;
      if (motion && this.baseBody) return animateDefaultAvatar(this.baseBody, motion);
    }
    return null;
  }

  /**
   * Flying tips the body into its direction of travel, further the faster it
   * goes: forward when flying ahead, sideways when strafing. Eases back upright
   * on landing.
   */
  private lean(motion: AvatarMotion | undefined, currentHeight: number): void {
    if (!this.root) return;
    let pitch = 0;
    let roll = 0;
    if (motion?.flying && motion.heading !== undefined && currentHeight > 0) {
      const delta = motion.heading - this.facing;
      const amount = Math.min(FLY_LEAN_MAX, motion.speed / FLY_LEAN_SPEED);
      // Positive x tips the head back and positive z tips it left, so ahead is negative.
      pitch = -Math.cos(delta) * amount * FLY_PITCH;
      roll = Math.sin(delta) * amount * FLY_ROLL;
    }
    const blend = motion ? 1 - Math.exp(-6 * motion.dt) : 1;
    this.leanPitch = MathUtils.lerp(this.leanPitch, pitch, blend);
    this.leanRoll = MathUtils.lerp(this.leanRoll, roll, blend);
    this.root.rotation.x = this.leanPitch;
    this.root.rotation.z = this.leanRoll;
  }

  setExpression(expression: AvatarExpression): void {
    this.expression = expression;
    if (this.baseBody && this.isDefaultAvatar) setAvatarExpression(this.baseBody, expression);
  }

  setVisible(visible: boolean): void {
    if (this.root) this.root.visible = visible;
  }

  dispose(): void {
    this.clearExternalBody();
    this.root?.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.root?.removeFromParent();
  }
}

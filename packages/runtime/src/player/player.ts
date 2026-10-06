import { Group, Mesh, Object3D, type Vector3 } from 'three';
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
    this.root.position.copy(feet);
    this.root.rotation.y = this.facing;
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

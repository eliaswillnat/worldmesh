import { Group, Mesh, Object3D, type Vector3 } from 'three';
import type { PlayerOptions } from '../types';
import {
  animateDefaultAvatar,
  createDefaultAvatar,
  setAvatarExpression,
  type AvatarExpression,
  type AvatarMotion,
} from './avatar';

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
    this.root.add(body as Object3D);
  }

  /** Place the avatar at the player's feet, facing `yaw`, and animate it for `motion`. */
  sync(feet: Vector3, yaw: number, currentHeight: number, motion?: AvatarMotion, freeLook = false): void {
    if (!freeLook) this.facing = yaw;
    else if (motion && motion.speed > 0.3 && motion.heading !== undefined) {
      let delta = motion.heading - this.facing;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.facing += delta * (1 - Math.exp(-12 * motion.dt));
    }
    if (!this.root) return;
    this.root.position.copy(feet);
    this.root.rotation.y = this.facing;
    if (this.isDefaultAvatar) {
      // Squash the default body while crouching instead of rebuilding it.
      this.root.scale.y = currentHeight / this.height;
      if (motion) animateDefaultAvatar(this.root.children[0], motion);
    }
  }

  setExpression(expression: AvatarExpression): void {
    this.expression = expression;
    if (this.root && this.isDefaultAvatar) setAvatarExpression(this.root.children[0], expression);
  }

  setVisible(visible: boolean): void {
    if (this.root) this.root.visible = visible;
  }

  dispose(): void {
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

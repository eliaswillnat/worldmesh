import { Group, Mesh, Object3D, type Vector3 } from 'three';
import type { PlayerOptions } from '../types';
import { animateDefaultAvatar, createDefaultAvatar, type AvatarMotion } from './avatar';

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
  sync(feet: Vector3, yaw: number, currentHeight: number, motion?: AvatarMotion): void {
    if (!this.root) return;
    this.root.position.copy(feet);
    this.root.rotation.y = yaw;
    if (this.isDefaultAvatar) {
      // Squash the default body while crouching instead of rebuilding it.
      this.root.scale.y = currentHeight / this.height;
      if (motion) animateDefaultAvatar(this.root.children[0], motion);
    }
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

import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type Vector3,
} from 'three';
import type { PlayerOptions } from '../types';

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

    const body = options.avatar ?? createDefaultAvatar(options.height, options.radius);
    this.root.add(body as Object3D);
  }

  /** Place the avatar at the player's feet, facing `yaw`. */
  sync(feet: Vector3, yaw: number, currentHeight: number): void {
    if (!this.root) return;
    this.root.position.copy(feet);
    this.root.rotation.y = yaw;
    if (this.isDefaultAvatar) {
      // Squash the default capsule while crouching instead of rebuilding it.
      this.root.scale.y = currentHeight / this.height;
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

function createDefaultAvatar(height: number, radius: number): Object3D {
  const group = new Group();
  const cylinderHeight = Math.max(0.1, height - radius * 2);

  const body = new Mesh(
    new CapsuleGeometry(radius, cylinderHeight, 6, 12),
    new MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.6, metalness: 0.05 }),
  );
  body.position.y = height / 2;
  body.castShadow = true;
  group.add(body);

  // A blunt nose so third person shows which way you are facing.
  const nose = new Mesh(
    new CapsuleGeometry(radius * 0.28, radius * 0.5, 4, 8),
    new MeshStandardMaterial({ color: 0x3aa0ff, roughness: 0.4 }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, height * 0.82, -radius * 0.9);
  group.add(nose);

  return group;
}

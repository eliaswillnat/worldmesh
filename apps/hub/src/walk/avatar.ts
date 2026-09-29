import { CapsuleGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';

export const AVATAR_HEIGHT = 1.8;
export const AVATAR_RADIUS = 0.35;

/**
 * The lobby's monochrome body. The local player and every remote visitor use
 * the same builder, so everyone looks like everyone else.
 */
export function createAvatar(): Object3D {
  const group = new Group();
  const cylinderHeight = AVATAR_HEIGHT - AVATAR_RADIUS * 2;

  const body = new Mesh(
    new CapsuleGeometry(AVATAR_RADIUS, cylinderHeight, 6, 16),
    new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35, metalness: 0.1 }),
  );
  body.position.y = AVATAR_HEIGHT / 2;
  group.add(body);

  // A dark visor so you can tell which way someone is facing.
  const visor = new Mesh(
    new CapsuleGeometry(AVATAR_RADIUS * 0.3, AVATAR_RADIUS * 0.9, 4, 12),
    new MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.15, metalness: 0.4 }),
  );
  visor.rotation.z = Math.PI / 2;
  visor.position.set(0, AVATAR_HEIGHT * 0.8, -AVATAR_RADIUS * 0.82);
  group.add(visor);

  return group;
}

export function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
  root.removeFromParent();
}

import {
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Object3D,
} from 'three';

/**
 * The default WorldMesh body: a small white figure with a big round head,
 * dot eyes, an egg-shaped body and stubby limbs. Every world gets the same
 * one until visitors bring their own, so it is deliberately plain.
 *
 * Built for a 1.8 m standing height with feet at y = 0, facing -Z (the
 * direction the camera looks at yaw 0). Scale the result for other heights.
 */

const RIG_KEY = 'worldmeshAvatarRig';

interface AvatarRig {
  torso: Group;
  head: Mesh;
  armL: Group;
  armR: Group;
  legL: Group;
  legR: Group;
  phase: number;
  stride: number;
  air: number;
}

export interface AvatarMotion {
  dt: number;
  /** Horizontal speed in metres per second. */
  speed: number;
  grounded: boolean;
}

export function createDefaultAvatar(height = 1.8): Group {
  const root = new Group();
  root.name = 'worldmesh:avatar';

  const skin = new MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.45, metalness: 0.02 });
  const ink = new MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });

  // One unit sphere, stretched into every body part.
  const sphere = new SphereGeometry(1, 28, 20);
  const blob = (sx: number, sy: number, sz: number, material = skin, geometry: BufferGeometry = sphere) => {
    const mesh = new Mesh(geometry, material);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    return mesh;
  };

  // Everything above the legs bobs together while walking.
  const torso = new Group();
  root.add(torso);

  const body = blob(0.25, 0.34, 0.2);
  body.position.y = 0.8;
  torso.add(body);

  const headRadius = 0.35;
  const headY = 1.44;
  const head = blob(headRadius, headRadius * 1.04, headRadius);
  head.position.y = headY;
  torso.add(head);

  // Features sit on the front of the head (the -Z side).
  const onHead = (x: number, y: number, inset = 0.012) => {
    const dy = (y - headY) / 1.04;
    return -Math.sqrt(Math.max(0, headRadius * headRadius - x * x - dy * dy)) + inset;
  };
  for (const side of [-1, 1]) {
    const eye = blob(0.028, 0.045, 0.02, ink);
    eye.position.set(side * 0.12, 1.49, onHead(side * 0.12, 1.49));
    eye.castShadow = false;
    torso.add(eye);
  }
  const mouth = blob(0.055, 0.009, 0.015, ink);
  mouth.position.set(0, 1.33, onHead(0, 1.33));
  mouth.castShadow = false;
  torso.add(mouth);

  // Limbs hang from pivots at the shoulders and hips so they can swing.
  const limb = (x: number, pivotY: number, length: number, radius: number, target: Object3D) => {
    const pivot = new Group();
    pivot.position.set(x, pivotY, 0);
    const mesh = blob(radius, length / 2, radius);
    mesh.position.y = -length / 2;
    pivot.add(mesh);
    target.add(pivot);
    return pivot;
  };
  const armL = limb(-0.35, 1.04, 0.5, 0.095, torso);
  const armR = limb(0.35, 1.04, 0.5, 0.095, torso);
  const legL = limb(-0.1, 0.46, 0.46, 0.105, root);
  const legR = limb(0.1, 0.46, 0.46, 0.105, root);

  const rig: AvatarRig = { torso, head, armL, armR, legL, legR, phase: 0, stride: 0, air: 0 };
  root.userData[RIG_KEY] = rig;

  if (height !== 1.8) root.scale.setScalar(height / 1.8);
  return root;
}

/**
 * Swing the limbs of an avatar made by `createDefaultAvatar`. Call once per
 * frame with how fast it is moving; anything else is ignored, so it is safe
 * to call on custom avatars too.
 */
export function animateDefaultAvatar(avatar: Object3D, motion: AvatarMotion): void {
  const rig = avatar.userData[RIG_KEY] as AvatarRig | undefined;
  if (!rig || motion.dt <= 0) return;

  const blend = 1 - Math.exp(-motion.dt * 10);
  const walking = motion.grounded ? MathUtils.clamp(motion.speed / 4.5, 0, 1) : 0;
  rig.stride += (walking - rig.stride) * blend;
  rig.air += ((motion.grounded ? 0 : 1) - rig.air) * blend;

  // Steps get longer, not just faster, as speed rises.
  rig.phase += motion.dt * (4 + motion.speed * 1.2) * (rig.stride > 0.01 ? 1 : 0);
  const swing = Math.sin(rig.phase) * 0.75 * rig.stride;

  rig.legL.rotation.x = swing + rig.air * 0.35;
  rig.legR.rotation.x = -swing - rig.air * 0.15;
  rig.armL.rotation.x = -swing * 0.8;
  rig.armR.rotation.x = swing * 0.8;
  rig.armL.rotation.z = -rig.air * 0.6;
  rig.armR.rotation.z = rig.air * 0.6;

  rig.torso.position.y = Math.abs(Math.cos(rig.phase)) * 0.045 * rig.stride;
  rig.head.rotation.z = Math.sin(rig.phase) * 0.04 * rig.stride;
}

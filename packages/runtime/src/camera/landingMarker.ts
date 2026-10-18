import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Vector3,
} from 'three';

/** The marker's size at this bird's-eye distance; further up it grows, so it stays as easy to see. */
const BASE_DISTANCE = 40;

/**
 * Where a click lands the player from the bird's-eye view: a ring on the
 * floor and a beam up from it, drawn over everything so a roof or a tree
 * never hides it.
 */
export class LandingMarker {
  readonly root = new Group();
  private ring: Mesh;
  private beam: Mesh;
  private materials: MeshBasicMaterial[];

  constructor() {
    this.root.name = 'worldmesh-landing-marker';
    this.root.visible = false;
    const material = (opacity: number) =>
      new MeshBasicMaterial({
        // Strong enough to read on a white floor and against a pale sky.
        color: 0x2f6bff,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      });
    this.materials = [material(0.9), material(0.5)];
    this.ring = new Mesh(new RingGeometry(0.55, 0.75, 48), this.materials[0]);
    this.ring.rotation.x = -Math.PI / 2;
    this.beam = new Mesh(new CylinderGeometry(0.06, 0.06, 1, 8, 1, true), this.materials[1]);
    for (const mesh of [this.ring, this.beam]) {
      mesh.renderOrder = 999;
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
  }

  /** Show the marker at `point`, sized for a camera `distance` away; null hides it. */
  update(point: Vector3 | null, distance: number, time: number): void {
    this.root.visible = point !== null;
    if (!point) return;
    const scale = Math.max(1, distance / BASE_DISTANCE);
    const pulse = 1 + 0.12 * Math.sin(time * 5);
    this.root.position.copy(point);
    this.root.position.y += 0.03;
    this.ring.scale.setScalar(scale * pulse);
    const height = 2.4 * scale;
    this.beam.scale.set(scale, height, scale);
    this.beam.position.y = height / 2;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.ring.geometry.dispose();
    this.beam.geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}

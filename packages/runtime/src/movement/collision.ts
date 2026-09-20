import { Object3D, Raycaster, Vector3 } from 'three';

const DOWN = new Vector3(0, -1, 0);

export interface GroundSample {
  /**
   * Surface height under the player. `-Infinity` when the world has colliders
   * but none of them are below the player — that is a hole, and the player
   * should keep falling rather than snap to an imaginary floor.
   */
  y: number;
  hit: boolean;
}

/**
 * Deliberately minimal collision: raycasts against a world-supplied list of
 * meshes. No physics engine, no broadphase. It is enough to stand on things
 * and to stop walking through walls, which is all the MVP needs to prove that
 * one controller works across five very different worlds.
 */
export class CollisionWorld {
  private raycaster = new Raycaster();
  private colliders: Object3D[] = [];
  private source: Object3D[] | (() => Object3D[]);
  /** Y used when a world supplies no colliders at all. */
  groundLevel: number;

  constructor(source: Object3D[] | (() => Object3D[]) = [], groundLevel = 0) {
    this.source = source;
    this.groundLevel = groundLevel;
    this.refresh();
  }

  refresh(): void {
    this.colliders = typeof this.source === 'function' ? this.source() : this.source;
  }

  get isEmpty(): boolean {
    return this.colliders.length === 0;
  }

  /**
   * Find the ground under `position`. `stepHeight` lets the player walk up
   * small ledges without jumping; `maxDrop` limits how far down we look.
   */
  sampleGround(position: Vector3, stepHeight = 0.6, maxDrop = 4): GroundSample {
    if (this.isEmpty) return { y: this.groundLevel, hit: false };

    this.raycaster.set(new Vector3(position.x, position.y + stepHeight, position.z), DOWN);
    this.raycaster.far = stepHeight + maxDrop;
    const hits = this.raycaster.intersectObjects(this.colliders, true);
    const hit = hits.find((candidate) => candidate.face !== null) ?? hits[0];
    if (!hit) return { y: -Infinity, hit: false };
    return { y: hit.point.y, hit: true };
  }

  /**
   * Slide a horizontal movement `delta` along whatever it runs into.
   * Two passes so that sliding into a corner does not tunnel through it.
   */
  resolveHorizontal(feet: Vector3, delta: Vector3, radius: number, height: number): Vector3 {
    const result = delta.clone();
    if (this.isEmpty || (result.x === 0 && result.z === 0)) return result;

    // Probe up the body: a knee-only ray walks through railings, a chest-only
    // ray walks through crates, and two rays miss anything between them.
    const heights = [height * 0.15, height * 0.4, height * 0.65, height * 0.9];
    const probe = new Vector3();
    const direction = new Vector3();

    for (let pass = 0; pass < 2; pass++) {
      const distance = Math.hypot(result.x, result.z);
      if (distance < 1e-5) break;
      direction.set(result.x, 0, result.z).divideScalar(distance);

      let blocked = false;
      for (const offset of heights) {
        probe.set(feet.x, feet.y + offset, feet.z);
        this.raycaster.set(probe, direction);
        this.raycaster.far = distance + radius;
        const hit = this.raycaster.intersectObjects(this.colliders, true)[0];
        if (!hit || !hit.face) continue;

        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        normal.y = 0;
        if (normal.lengthSq() < 1e-6) continue;
        normal.normalize();

        const into = result.dot(normal);
        if (into < 0) {
          result.addScaledVector(normal, -into);
          blocked = true;
        }
      }
      if (!blocked) break;
    }

    return result;
  }

  /** Distance from `origin` along `direction` before hitting something. */
  castDistance(origin: Vector3, direction: Vector3, far: number): number {
    if (this.isEmpty) return far;
    this.raycaster.set(origin, direction);
    this.raycaster.far = far;
    const hit = this.raycaster.intersectObjects(this.colliders, true)[0];
    return hit ? hit.distance : far;
  }
}

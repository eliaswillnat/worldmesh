import { Box3, InstancedMesh, Matrix4, Mesh, Triangle, Vector3, type BufferAttribute, type Object3D } from 'three';

/**
 * What stops walkers at a building (docs/specs/buildings.md §7.5): the
 * building's own triangles, so people walk up its steps, round its towers
 * and under its arches, except in its doorway, which stays clear all the way
 * through so the door can be walked into. Plain geometry: no DOM, no
 * loading, so the tests read the same rules. The hub puts a bounding volume
 * hierarchy over the result (three-mesh-bvh), so walking against a big
 * model costs about what walking against a box did.
 */

/** Triangles cut down to about this size where they cross the doorway, then dropped (metres). */
const CARVE_SIZE = 0.2;
/** Smaller than this and a triangle is too thin to stop anyone. */
const SLIVER = 1e-10;

/**
 * Every visible triangle under `root`, in the space `toFrame` maps the
 * world into, without what falls inside `passage` (in that same space).
 * Positions, three vertices to a triangle.
 */
export function colliderTriangles(root: Object3D, toFrame: Matrix4, passage: Box3): Float32Array {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const matrix = new Matrix4();
  const instance = new Matrix4();
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const position = object.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position) return;
    const index = object.geometry.getIndex();
    const count = index ? index.count : position.count;
    const copies = object instanceof InstancedMesh ? object.count : 1;
    for (let copy = 0; copy < copies; copy++) {
      matrix.multiplyMatrices(toFrame, object.matrixWorld);
      if (object instanceof InstancedMesh) {
        object.getMatrixAt(copy, instance);
        matrix.multiply(instance);
      }
      for (let i = 0; i + 2 < count; i += 3) {
        const at = (k: number) => (index ? index.getX(i + k) : i + k);
        a.fromBufferAttribute(position, at(0)).applyMatrix4(matrix);
        b.fromBufferAttribute(position, at(1)).applyMatrix4(matrix);
        c.fromBufferAttribute(position, at(2)).applyMatrix4(matrix);
        carve(a.clone(), b.clone(), c.clone(), passage, out);
      }
    }
  });
  return new Float32Array(out);
}

/**
 * The doorway's clear space, in its door's frame: the opening, from `front`
 * out in the street to `back` behind it, and from well under the street up.
 */
export function doorPassage(width: number, height: number, front: number, back: number): Box3 {
  return new Box3(new Vector3(-width / 2, -height, -back), new Vector3(width / 2, height, front));
}

/**
 * Index for `triangles` that has every one twice, once each way round: a
 * wall stops people from either side, whichever way its maker wound it,
 * and a hit always reports the side that was walked into.
 */
export function bothSides(triangleCount: number): Uint32Array {
  const index = new Uint32Array(triangleCount * 6);
  for (let t = 0; t < triangleCount; t++) {
    const v = t * 3;
    index.set([v, v + 1, v + 2, v, v + 2, v + 1], t * 6);
  }
  return index;
}

/** Keep a triangle, or the parts of it outside `passage`, cut down near its edges. */
function carve(a: Vector3, b: Vector3, c: Vector3, passage: Box3, out: number[]): void {
  const area = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).lengthSq();
  if (area < SLIVER) return;
  if (!passage.intersectsTriangle(new Triangle(a, b, c))) {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    return;
  }
  if (passage.containsPoint(a) && passage.containsPoint(b) && passage.containsPoint(c)) return;
  if (Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) <= CARVE_SIZE) return;
  // Four smaller triangles, each wound as the whole was.
  const ab = a.clone().lerp(b, 0.5);
  const bc = b.clone().lerp(c, 0.5);
  const ca = c.clone().lerp(a, 0.5);
  carve(a, ab, ca, passage, out);
  carve(ab, b, bc, passage, out);
  carve(ca, bc, c, passage, out);
  carve(ab, bc, ca, passage, out);
}

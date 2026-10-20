import { Box3, Group, Matrix4, Mesh, Vector3, type BufferAttribute, type Material, type Object3D } from 'three';

/**
 * A building's portal face, and how the building fits its lot
 * (docs/specs/buildings.md §3.2 and §6). Plain geometry: no DOM, no loading,
 * so the hub and the tests read the same rules.
 */

/** `portal`, `Portal`, `portal.001`, or a named portal such as `portal:arena` (§3.4). */
const PORTAL_NAME = /^portal(:[^.]*)?(\.\d+)?$/i;
/** The face may lean this far from upright (its normal this far from level). */
const MAX_LEAN = Math.PI / 6;
/** How far a portal face's points may stray from its plane, as a share of its size. */
const FLATNESS = 0.02;
/** A fitted doorway at least this wide and tall, so a visitor fits through. */
export const MIN_PORTAL_WIDTH = 2;
export const MIN_PORTAL_HEIGHT = 2.5;

export function isPortalMaterial(material: Material | Material[] | null | undefined): boolean {
  return !Array.isArray(material) && Boolean(material) && PORTAL_NAME.test(material!.name.trim());
}

/** The doorway a portal face makes, in the model's own space. */
export interface PortalFace {
  /** Middle of its upright rectangle. */
  center: Vector3;
  /** Level, unit length, pointing out of the building. */
  normal: Vector3;
  width: number;
  height: number;
}

/**
 * The model's portal face: `face` once found, the meshes that make it up
 * (to be hidden, since the door takes their place), and `problem` when the
 * face is there but can't be a door. No portal material at all is neither:
 * the building gets a standard door at its front (§3.3).
 */
export interface PortalSearch {
  face: PortalFace | null;
  meshes: Mesh[];
  problem: string | null;
}

/**
 * Find the portal face of `root` (§6.1): the triangles of its first mesh with
 * a portal material, in `root`'s space.
 */
export function findPortalFace(root: Object3D): PortalSearch {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh && isPortalMaterial(object.material)) meshes.push(object);
  });
  if (!meshes.length) return { face: null, meshes, problem: null };
  // A named portal later in the file is kept for a later version; the first one is the door.
  const first = (meshes[0].material as Material).name.trim().split('.')[0].toLowerCase();
  const door = meshes.filter((mesh) => (mesh.material as Material).name.trim().split('.')[0].toLowerCase() === first);

  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const triangles: Vector3[][] = [];
  for (const mesh of door) {
    const position = mesh.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position) continue;
    const matrix = new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const corner = (i: number) => new Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const at = (k: number) => (index ? index.getX(i + k) : i + k);
      triangles.push([corner(at(0)), corner(at(1)), corner(at(2))]);
    }
  }
  return { ...faceFrom(triangles, new Box3().setFromObject(root, true)), meshes: door };
}

/** The upright rectangle a set of triangles makes, checked flat, upright and turned out of `bounds` (§6.1). */
export function faceFrom(triangles: Vector3[][], bounds: Box3): { face: PortalFace | null; problem: string | null } {
  const crosses = triangles.map(([a, b, c]) => new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)));
  const largest = crosses.reduce((best, cross) => (cross.lengthSq() > best.lengthSq() ? cross : best), new Vector3());
  if (largest.lengthSq() < 1e-12) return { face: null, problem: 'The portal face has no area.' };
  // Area-weighted, every triangle counted the same way round, however it was wound.
  const normal = new Vector3();
  for (const cross of crosses) normal.addScaledVector(cross, cross.dot(largest) < 0 ? -1 : 1);
  normal.normalize();

  const points = triangles.flat();
  const centroid = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
  const size = new Box3().setFromPoints(points).getSize(new Vector3()).length();
  const stray = Math.max(...points.map((point) => Math.abs(new Vector3().subVectors(point, centroid).dot(normal))));
  if (stray > FLATNESS * size) return { face: null, problem: 'The portal face is not flat.' };
  if (Math.abs(normal.y) > Math.sin(MAX_LEAN)) return { face: null, problem: 'The portal face is not upright: it must face within 30° of level.' };

  normal.setY(0).normalize();
  // Out of the building: away from its middle, or towards its front (+Z) when it stands in the middle.
  const middle = bounds.getCenter(new Vector3());
  const inward = new Vector3().subVectors(middle, centroid).dot(normal);
  const depth = bounds.getSize(new Vector3()).length();
  if (inward > depth * 0.01 || (Math.abs(inward) <= depth * 0.01 && normal.z < 0)) normal.negate();

  // Across the face, level; and up.
  const across = new Vector3(normal.z, 0, -normal.x);
  let minA = Infinity;
  let maxA = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const a = new Vector3().subVectors(point, centroid).dot(across);
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const center = centroid.clone().addScaledVector(across, (minA + maxA) / 2).setY((minY + maxY) / 2);
  return { face: { center, normal, width: maxA - minA, height: maxY - minY }, problem: null };
}

/**
 * The turn about +Y that points a portal face's normal out along +Z, the way
 * a door faces the street in its own frame.
 */
export function portalYaw(face: PortalFace): number {
  return -Math.atan2(face.normal.x, face.normal.z);
}

/** The room a building may fill round its door: its world's whole block (§2). */
export interface Lot {
  /** Along the wall, centred on the door. */
  width: number;
  /** Into the block, behind the wall line. */
  depth: number;
  /** Out into the street, in front of the wall line. */
  forecourt: number;
  height: number;
}

/** A building fitted to its lot: the scale it stands at, and what to move it by. */
export interface Fit {
  scale: number;
  /** The model's own space (already turned to face +Z) into its door's frame. */
  matrix: Matrix4;
}

/**
 * Fit a model, already turned so its door faces +Z, into `lot` (§6.2):
 * `bounds` is the turned model's box and `anchor` the point that goes on the
 * door's foot: the portal face's bottom middle, or the middle of the
 * model's front at the ground without one. The door stands `out` metres in
 * front of the wall line. The largest uniform scale at which everything in
 * front of the anchor fits the forecourt, everything behind it the lot's
 * depth, and the whole the lot's width and height. Below the anchor goes
 * under the street.
 */
export function fitToLot(bounds: Box3, anchor: Vector3, lot: Lot, out: number): Fit {
  const limits: Array<[number, number]> = [
    [lot.width / 2, anchor.x - bounds.min.x],
    [lot.width / 2, bounds.max.x - anchor.x],
    [lot.forecourt - out, bounds.max.z - anchor.z],
    [lot.depth + out, anchor.z - bounds.min.z],
    [lot.height, bounds.max.y - anchor.y],
  ];
  let scale = Infinity;
  for (const [room, extent] of limits) if (extent > 1e-6) scale = Math.min(scale, Math.max(0, room) / extent);
  if (!Number.isFinite(scale)) scale = 1;
  const matrix = new Matrix4().makeScale(scale, scale, scale).multiply(new Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z));
  return { scale, matrix };
}

/** Why a fitted portal face is too small to walk through, or null (§6.3). */
export function portalTooSmall(face: PortalFace, scale: number): string | null {
  const width = face.width * scale;
  const height = face.height * scale;
  if (width >= MIN_PORTAL_WIDTH && height >= MIN_PORTAL_HEIGHT) return null;
  return `The portal face comes out ${width.toFixed(1)} m × ${height.toFixed(1)} m in its lot; it needs at least ${MIN_PORTAL_WIDTH} m × ${MIN_PORTAL_HEIGHT} m.`;
}

/** A model worked out for its lot (§6): how to turn and fit it, and the doorway it makes. */
export interface BuildingPlan {
  /** Why it can't stand there, or null. */
  problem: string | null;
  /** Turns the model so its door faces +Z. */
  turn: Matrix4;
  /** The turned model's box. */
  bounds: Box3;
  fit: Fit;
  /** The doorway its portal face makes, in metres, or null for the standard door at its front. */
  door: { width: number; height: number } | null;
  /** The meshes the door takes the place of. */
  portalMeshes: Mesh[];
}

/** Find the portal face, turn the model to it and fit it to `lot`, its door `out` metres in front of the wall line. */
export function planBuilding(model: Object3D, lot: Lot, out: number): BuildingPlan {
  const search = findPortalFace(model);
  const yaw = search.face ? portalYaw(search.face) : 0;
  const turn = new Matrix4().makeRotationY(yaw);
  const turned = new Group();
  turned.rotation.y = yaw;
  const parent = model.parent;
  turned.add(model);
  const bounds = new Box3().setFromObject(turned, true);
  turned.remove(model);
  parent?.add(model);
  const anchor = search.face
    ? search.face.center.clone().setY(search.face.center.y - search.face.height / 2).applyMatrix4(turn)
    : new Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y, bounds.max.z);
  const fit = fitToLot(bounds, anchor, lot, out);
  const small = search.face && portalTooSmall(search.face, fit.scale);
  return {
    problem: search.problem ?? small ?? null,
    turn,
    bounds,
    fit,
    door: search.face ? { width: search.face.width * fit.scale, height: search.face.height * fit.scale } : null,
    portalMeshes: search.meshes,
  };
}

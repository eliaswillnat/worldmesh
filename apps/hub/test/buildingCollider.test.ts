import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3 } from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { bothSides, colliderTriangles, doorPassage } from '../src/walk/buildingCollider';

/** The collider the city makes of `root`, its door at the origin facing +Z. */
function collider(root: Group, width = 2, height = 3): Mesh {
  const positions = colliderTriangles(root, new Matrix4(), doorPassage(width, height, 0.5, 12));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(bothSides(positions.length / 9), 1));
  geometry.boundsTree = new MeshBVH(geometry);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.raycast = acceleratedRaycast;
  return mesh;
}

function hit(mesh: Mesh, from: Vector3, toward: Vector3, far = 50) {
  const raycaster = new Raycaster(from, toward.clone().normalize(), 0, far);
  return raycaster.intersectObject(mesh)[0] ?? null;
}

/** A 10 × 8 wall at z = 0, two triangles, with a 6 m deep box of a building behind it. */
function building(): Group {
  const root = new Group();
  const wall = new Mesh(new PlaneGeometry(10, 8).translate(0, 4, 0), new MeshBasicMaterial());
  const body = new Mesh(new BoxGeometry(10, 8, 6).translate(0, 4, -3.01), new MeshBasicMaterial());
  root.add(wall, body);
  return root;
}

describe("a building's collider", () => {
  it('leaves the doorway clear all the way through, and the wall round it solid', () => {
    const mesh = collider(building());
    // Straight through the door, into the building and out of its back: nothing.
    expect(hit(mesh, new Vector3(0, 1.5, 5), new Vector3(0, 0, -1))).toBeNull();
    expect(hit(mesh, new Vector3(0.8, 2.8, 5), new Vector3(0, 0, -1))).toBeNull();
    // Beside the door and over it: the wall.
    expect(hit(mesh, new Vector3(1.5, 1.5, 5), new Vector3(0, 0, -1))!.distance).toBeCloseTo(5);
    expect(hit(mesh, new Vector3(-3, 1, 5), new Vector3(0, 0, -1))!.distance).toBeCloseTo(5);
    expect(hit(mesh, new Vector3(0, 3.5, 5), new Vector3(0, 0, -1))!.distance).toBeCloseTo(5);
  });

  it('stops people on either side of a wall, the hit facing whoever walked into it', () => {
    const mesh = collider(building());
    const outside = hit(mesh, new Vector3(-3, 1, 5), new Vector3(0, 0, -1))!;
    expect(outside.face!.normal.z).toBeCloseTo(1);
    // From inside the building, out through the side wall.
    const inside = hit(mesh, new Vector3(0, 1, -3), new Vector3(1, 0, 0))!;
    expect(inside.distance).toBeCloseTo(5);
    expect(inside.face!.normal.x).toBeCloseTo(-1);
  });

  it('can be stood on: its roof, from above', () => {
    const mesh = collider(building());
    expect(hit(mesh, new Vector3(3, 20, -3), new Vector3(0, -1, 0))!.point.y).toBeCloseTo(8);
  });

  it('leaves out what is hidden, such as the portal face the door takes the place of', () => {
    const root = building();
    const portal = new Mesh(new PlaneGeometry(10, 8).translate(0, 4, 2), new MeshBasicMaterial());
    portal.visible = false;
    root.add(portal);
    expect(hit(collider(root), new Vector3(-3, 1, 5), new Vector3(0, 0, -1))!.distance).toBeCloseTo(5);
  });

  it('keeps every triangle of a building whose door is elsewhere, uncut', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(4, 4, 4).translate(20, 2, 0), new MeshBasicMaterial()));
    expect(colliderTriangles(root, new Matrix4(), doorPassage(2, 3, 0.5, 12)).length).toBe(12 * 9);
  });

  it('cuts only near the doorway, and keeps the triangle count in hand', () => {
    const triangles = colliderTriangles(building(), new Matrix4(), doorPassage(2, 3, 0.5, 12)).length / 9;
    // Two triangles of wall and twelve of box became a few hundred round the doorway, not tens of thousands.
    expect(triangles).toBeGreaterThan(14);
    expect(triangles).toBeLessThan(2000);
  });
});

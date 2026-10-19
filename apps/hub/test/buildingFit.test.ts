import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Vector3 } from 'three';
import { findPortalFace, fitToLot, isPortalMaterial, portalTooSmall, portalYaw, type Lot } from '../src/walk/buildingFit';

const LOT: Lot = { width: 13.5, depth: 6.8, forecourt: 2, height: 28 };
const OUT = 0.3;

/** A 4 × 6 × 3 box of a building, its front at z = 1.5, with a 2 × 3 portal face on the front. */
function building(name = 'portal', turn = 0): Group {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(4, 6, 3).translate(0, 3, 0), new MeshStandardMaterial({ name: 'stone' })));
  const portal = new Mesh(new PlaneGeometry(2, 3), new MeshStandardMaterial({ name }));
  portal.position.set(0, 1.5, 1.51);
  root.add(portal);
  root.rotation.y = turn;
  const holder = new Group();
  holder.add(root);
  return holder;
}

describe('portal material names', () => {
  it('matches portal however Blender spells it, and named portals', () => {
    for (const name of ['portal', 'Portal', 'PORTAL', ' portal ', 'portal.001', 'portal:arena', 'portal:arena.002']) {
      expect(isPortalMaterial(new MeshStandardMaterial({ name }))).toBe(true);
    }
    for (const name of ['', 'portals', 'my portal', 'door', 'portal-glass']) {
      expect(isPortalMaterial(new MeshStandardMaterial({ name }))).toBe(false);
    }
  });
});

describe('finding the portal face', () => {
  it('finds the face, its size, and that it faces out of the building', () => {
    const search = findPortalFace(building());
    expect(search.problem).toBeNull();
    expect(search.meshes).toHaveLength(1);
    const face = search.face!;
    expect(face.width).toBeCloseTo(2);
    expect(face.height).toBeCloseTo(3);
    expect(face.center.y).toBeCloseTo(1.5);
    expect(face.normal.z).toBeCloseTo(1);
  });

  it('faces it out however the face itself was wound', () => {
    const model = building();
    // Turn the plane round to face into the box.
    model.children[0].children[1].rotation.y = Math.PI;
    expect(findPortalFace(model).face!.normal.z).toBeCloseTo(1);
  });

  it('follows the model round, wherever its portal faces', () => {
    const face = findPortalFace(building('portal', Math.PI / 2)).face!;
    expect(face.normal.x).toBeCloseTo(1);
    expect(face.normal.z).toBeCloseTo(0);
    // Turned back, it faces +Z, as a door in its own frame does.
    const yaw = portalYaw(face);
    const turned = face.normal.clone().applyMatrix4(new Matrix4().makeRotationY(yaw));
    expect(turned.z).toBeCloseTo(1);
  });

  it('says so when there is no portal, and refuses one lying flat or bent', () => {
    expect(findPortalFace(building('glass'))).toMatchObject({ face: null, problem: null, meshes: [] });

    const flat = building();
    flat.children[0].children[1].rotation.x = -Math.PI / 2;
    expect(findPortalFace(flat).problem).toMatch(/upright/);

    const bent = building();
    const plane = bent.children[0].children[1] as Mesh;
    const position = plane.geometry.getAttribute('position');
    position.setZ(0, 0.8);
    expect(findPortalFace(bent).problem).toMatch(/flat/);
  });
});

describe('fitting a building to its lot', () => {
  const anchorOf = (face: { center: Vector3; height: number }) => face.center.clone().setY(face.center.y - face.height / 2);

  it('scales it up to the largest size that fits, without stretching', () => {
    const model = building();
    const face = findPortalFace(model).face!;
    const bounds = new Box3().setFromObject(model, true);
    const fit = fitToLot(bounds, anchorOf(face), LOT, OUT);
    // 3.01 m of model behind a portal just in front of the box: depth binds.
    expect(fit.scale).toBeCloseTo((LOT.depth + OUT) / 3.01, 4);
    // Everything ends up inside the lot, the door's foot on the origin.
    const placed = bounds.clone().applyMatrix4(fit.matrix);
    expect(placed.min.x).toBeGreaterThanOrEqual(-LOT.width / 2 - 1e-6);
    expect(placed.max.x).toBeLessThanOrEqual(LOT.width / 2 + 1e-6);
    expect(placed.min.z).toBeGreaterThanOrEqual(-(LOT.depth + OUT) - 1e-6);
    expect(placed.max.z).toBeLessThanOrEqual(LOT.forecourt - OUT + 1e-6);
    expect(placed.max.y).toBeLessThanOrEqual(LOT.height + 1e-6);
    expect(anchorOf(face).applyMatrix4(fit.matrix).length()).toBeLessThan(1e-6);
    expect(portalTooSmall(face, fit.scale)).toBeNull();
  });

  it('is held by the height for a tall tower, and by the width for a wide hall', () => {
    const tower = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 40, 0));
    expect(fitToLot(tower, new Vector3(0, 0, 0), LOT, OUT).scale).toBeCloseTo(LOT.height / 40);
    const hall = new Box3(new Vector3(-20, 0, -1), new Vector3(20, 4, 0));
    expect(fitToLot(hall, new Vector3(0, 0, 0), LOT, OUT).scale).toBeCloseTo(LOT.width / 2 / 20);
  });

  it('refuses a portal too small to walk through', () => {
    const face = { center: new Vector3(), normal: new Vector3(0, 0, 1), width: 1, height: 1 };
    expect(portalTooSmall(face, 1.5)).toMatch(/at least/);
    expect(portalTooSmall(face, 3)).toBeNull();
  });
});

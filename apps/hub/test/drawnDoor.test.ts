import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findPortalFace, isPortalMaterial } from '../src/walk/buildingFit';
import { inspectBuilding, readGlbJson } from '../src/walk/buildingModel';
import { addDoorToGlb, doorCorners } from '../src/walk/drawnDoor';
import demo from '../src/walk/demoBuildings.json';

const PUBLIC = join(__dirname, '../public');

function file(url: string): ArrayBuffer {
  const data = readFileSync(join(PUBLIC, url));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

const parse = (glb: ArrayBuffer) => new GLTFLoader().parseAsync(glb, '').then((gltf) => gltf.scene);

describe('the rectangle a drag draws', () => {
  it('runs up the wall and across it, whichever way it was dragged', () => {
    const normal = new Vector3(0, 0, 1);
    const one = doorCorners(new Vector3(-1, 0, 1.5), new Vector3(1, 3, 1.5), normal, 0.01);
    const other = doorCorners(new Vector3(1, 3, 1.5), new Vector3(-1, 0, 1.5), normal, 0.01);
    const expected = [
      [-1, 0],
      [1, 0],
      [1, 3],
      [-1, 3],
    ];
    for (const corners of [one, other]) {
      corners.forEach((corner, i) => {
        expect(corner.x).toBeCloseTo(expected[i][0]);
        expect(corner.y).toBeCloseTo(expected[i][1]);
        expect(corner.z).toBeCloseTo(1.51);
      });
    }
  });

  it('is wound to face out of the wall it was drawn on', () => {
    for (const normal of [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0.6, 0.3, 0.74).normalize()]) {
      const across = new Vector3(normal.z, 0, -normal.x).normalize();
      const [a, b, , d] = doorCorners(new Vector3(), across.multiplyScalar(2).add(new Vector3(0, 3, 0)).projectOnPlane(normal), normal, 0);
      expect(a.distanceTo(b)).toBeGreaterThan(1);
      const facing = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize();
      expect(facing.dot(normal)).toBeCloseTo(1);
      // Its sides go straight up the wall.
      expect(new Vector3().subVectors(d, a).x * normal.z - new Vector3().subVectors(d, a).z * normal.x).toBeCloseTo(0);
    }
  });
});

describe('writing a drawn door into a GLB', () => {
  it('makes the drawn face the door, and the old portal an ordinary face', async () => {
    const original = file(demo[0].modelUrl);
    const before = findPortalFace(await parse(original)).face!;
    // A narrower door than the one it had, standing on the same spot.
    const bottom = before.center.clone().setY(before.center.y - before.height / 2);
    const across = new Vector3(before.normal.z, 0, -before.normal.x);
    const start = bottom.clone().addScaledVector(across, -before.width / 4);
    const end = bottom.clone().addScaledVector(across, before.width / 4).setY(bottom.y + before.height);
    const edited = addDoorToGlb(original, doorCorners(start, end, before.normal, 0.01));

    const model = await parse(edited);
    const search = findPortalFace(model);
    expect(search.problem).toBeNull();
    expect(search.meshes).toHaveLength(1);
    expect(search.face!.width).toBeCloseTo(before.width / 2);
    expect(search.face!.height).toBeCloseTo(before.height);
    expect(search.face!.normal.dot(before.normal)).toBeCloseTo(1);
    const names = readGlbJson(edited) as { materials: { name: string }[] };
    expect(names.materials.map((m) => m.name)).toContain('former portal');
    let portals = 0;
    model.traverse((object) => {
      if ('material' in object && isPortalMaterial(object.material as never)) portals++;
    });
    expect(portals).toBe(1);

    const check = await inspectBuilding(edited);
    expect(check.problem).toBeNull();
    expect(check.drawable).toBe(true);
    expect(check.door!.width).toBeLessThan((await inspectBuilding(original)).door!.width);
  });

  it('keeps every byte of the model it had', () => {
    const original = new Uint8Array(file(demo[0].modelUrl));
    const edited = new Uint8Array(addDoorToGlb(original.buffer as ArrayBuffer, doorCorners(new Vector3(), new Vector3(2, 3, 0), new Vector3(0, 0, 1), 0)));
    const binAt = (glb: Uint8Array) => 20 + new DataView(glb.buffer).getUint32(12, true) + 8;
    const length = new DataView(original.buffer).getUint32(binAt(original) - 8, true);
    expect(edited.subarray(binAt(edited), binAt(edited) + length)).toEqual(original.subarray(binAt(original), binAt(original) + length));
    expect(new DataView(edited.buffer).getUint32(8, true)).toBe(edited.byteLength);
    expect(edited.byteLength % 4).toBe(0);
  });

  it('adds a door to a file with nothing in it yet', async () => {
    const text = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }).padEnd(64, ' '));
    const glb = new Uint8Array(20 + text.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, text.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(text, 20);
    const edited = addDoorToGlb(glb.buffer, doorCorners(new Vector3(-1, 0, 0), new Vector3(1, 3, 0), new Vector3(0, 0, 1), 0));
    const face = findPortalFace(await parse(edited)).face!;
    expect(face.width).toBeCloseTo(2);
    expect(face.height).toBeCloseTo(3);
  });

  it('refuses what is not a GLB', () => {
    expect(() => addDoorToGlb(new TextEncoder().encode('not a model at all').buffer as ArrayBuffer, doorCorners(new Vector3(), new Vector3(1, 1, 0), new Vector3(0, 0, 1), 0))).toThrow(/glTF/);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Box3, Group, Matrix4 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findPortalFace, fitToLot, portalTooSmall, portalYaw } from '../src/walk/buildingFit';
import { inspectBuilding } from '../src/walk/buildingModel';
import { AVENUES } from '../src/walk/avenuePlan';
import { LOT_FORECOURT, LOT_HEIGHT } from '../src/walk/facade';
import demo from '../src/walk/demoBuildings.json';

const PUBLIC = join(__dirname, '../public');
// A whole block.
const LOT = { width: AVENUES.blockSize, depth: AVENUES.blockSize, forecourt: LOT_FORECOURT, height: LOT_HEIGHT };

describe('demo buildings', () => {
  for (const { modelUrl, sha256 } of demo) {
    it(`${modelUrl} is the listed file, finds its portal, and fits its lot`, async () => {
      const file = readFileSync(join(PUBLIC, modelUrl));
      expect(createHash('sha256').update(file).digest('hex')).toBe(sha256);
      expect(file.length).toBeLessThan(10 * 1024 * 1024);
      const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      const search = findPortalFace(gltf.scene);
      expect(search.problem).toBeNull();
      const face = search.face!;
      expect(face.normal.z).toBeCloseTo(1);
      const yaw = portalYaw(face);
      const turned = new Group();
      turned.rotation.y = yaw;
      turned.add(gltf.scene);
      const bounds = new Box3().setFromObject(turned, true);
      const anchor = face.center.clone().setY(face.center.y - face.height / 2).applyMatrix4(new Matrix4().makeRotationY(yaw));
      const fit = fitToLot(bounds, anchor, LOT, 0.3);
      expect(portalTooSmall(face, fit.scale)).toBeNull();
      // As big as the block lets it be: it touches one of the lot's limits, and crosses none.
      const placed = bounds.clone().applyMatrix4(fit.matrix);
      const reach = [
        placed.max.y / LOT.height,
        Math.max(-placed.min.x, placed.max.x) / (LOT.width / 2),
        placed.max.z / (LOT.forecourt - 0.3),
        -placed.min.z / (LOT.depth + 0.3),
      ];
      expect(Math.max(...reach)).toBeCloseTo(1, 5);
    });
  }
});

describe('checking a building before it is uploaded', () => {
  const file = (url: string) => {
    const data = readFileSync(join(PUBLIC, url));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  };

  it('finds the doorway each demo building makes on a block', async () => {
    for (const { modelUrl } of demo) {
      const check = await inspectBuilding(file(modelUrl));
      expect(check.problem).toBeNull();
      expect(check.door!.width).toBeGreaterThanOrEqual(2);
      expect(check.door!.height).toBeGreaterThanOrEqual(2.5);
      expect(check.triangles).toBeGreaterThan(0);
    }
  });

  it('refuses files the city would refuse, saying why', async () => {
    expect((await inspectBuilding(new ArrayBuffer(11 * 1024 * 1024))).problem).toMatch(/10 MB/);
    expect((await inspectBuilding(new TextEncoder().encode('not a model at all').buffer as ArrayBuffer)).problem).toMatch(/glTF/);
    // The same file, saying it needs Draco.
    const glb = new Uint8Array(file(demo[0].modelUrl));
    const view = new DataView(glb.buffer);
    const length = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
    json.extensionsUsed = ['KHR_draco_mesh_compression'];
    let text = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    padded.set(text);
    text = padded;
    const rest = glb.subarray(20 + length);
    const out = new Uint8Array(20 + text.length + rest.length);
    out.set(glb.subarray(0, 20));
    new DataView(out.buffer).setUint32(12, text.length, true);
    new DataView(out.buffer).setUint32(8, out.length, true);
    out.set(text, 20);
    out.set(rest, 20 + text.length);
    expect((await inspectBuilding(out.buffer)).problem).toMatch(/draco/i);
  });
});

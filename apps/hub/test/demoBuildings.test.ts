import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Box3, Group, Matrix4 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findPortalFace, fitToLot, portalTooSmall, portalYaw } from '../src/walk/buildingFit';
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

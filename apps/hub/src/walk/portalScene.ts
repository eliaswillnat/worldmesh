import {
  AmbientLight,
  Color,
  Fog,
  FogExp2,
  Group,
  HemisphereLight,
  Matrix4,
  Quaternion,
  Scene,
  Vector3,
  type CubeTexture,
  type Light,
  type Material,
  type Mesh,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import type { PortalSceneExtras, PortalSceneShadow } from '@worldmesh/runtime';
import { loadCoverTexture } from './door';
import { makeColorCube } from './doorViewCube';

/**
 * A world's portal scene, ready to draw through its door: the meshes near its
 * spawn point (from its portal.glb) with its lights and fog, and the backdrop
 * for everything further away. See exportPortal in @worldmesh/runtime.
 */
export interface LoadedPortal {
  /** Drawn from the visitor's own camera, after `place`. */
  scene: Scene;
  /** Sky and far scenery, in the spawn's frame (like a door view's colour). */
  backdrop: CubeTexture;
  /** The spawn's eye height above its feet. */
  eyeHeight: number;
  /** Nothing in the scene moves, so its shadows are drawn once, the first time it is. */
  shadowsDrawn: boolean;
  /** From the world's own coordinates to where `place` stood it in the lobby. */
  readonly placement: Matrix4;
  /**
   * Stand the world behind a door: its spawn point `spawnBehind` metres back
   * from the doorway, facing out of it, its ground level with the floor.
   */
  place(doorMatrixWorld: Matrix4, spawnBehind: number): void;
  dispose(): void;
}

/** Point and spot lights kept, the nearest to the spawn point: each costs every pixel of the doorway. */
const MAX_LOCAL_LIGHTS = 8;
/** Eye height above the arrival point when the scene doesn't say (Doorway §3). */
const DEFAULT_EYE_HEIGHT = 1.6;

/**
 * Where a Doorway scene is: the glTF file, and the backdrop if its source
 * names one (else the scene's own `extras.backdrop.uri`, next to the file).
 */
export interface PortalSource {
  glb: string;
  backdrop?: string | null;
}

/**
 * Load a Doorway scene (docs/specs/doorway.md §3); null if it won't load.
 * Everything is read from the glTF itself: the arrival point (OMI_spawn_point),
 * the lights (KHR_lights_punctual, read by GLTFLoader) and the scene extras.
 */
export async function loadPortal(info: PortalSource, renderer: WebGLRenderer): Promise<LoadedPortal | null> {
  const [buffer, { GLTFLoader }] = await Promise.all([fetchBuffer(info.glb), import('three/examples/jsm/loaders/GLTFLoader.js')]);
  if (!buffer) return null;
  let gltf: { scene: Group };
  try {
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch {
    return null;
  }
  gltf.scene.updateMatrixWorld(true);
  const extras = gltf.scene.userData as PortalSceneExtras;

  // The arrival point: feet at the node, facing its −Z.
  let spawn: Object3D | null = null;
  gltf.scene.traverse((object) => {
    if (!spawn && (object.userData.gltfExtensions as Record<string, unknown> | undefined)?.OMI_spawn_point) spawn = object;
  });
  if (!spawn) return null;
  const arrival = spawn as Object3D;
  const feet = arrival.getWorldPosition(new Vector3());
  const forward = new Vector3(0, 0, -1).applyQuaternion(arrival.getWorldQuaternion(new Quaternion()));
  const yaw = Math.atan2(-forward.x, -forward.z);
  const eyeHeight = typeof arrival.userData.eyeHeight === 'number' ? arrival.userData.eyeHeight : DEFAULT_EYE_HEIGHT;
  const eye = feet.clone().add(new Vector3(0, eyeHeight, 0));

  const backdropUrl = info.backdrop ?? (extras.backdrop?.uri ? new URL(extras.backdrop.uri, new URL(info.glb, window.location.href)).toString() : null);
  const backdropAtlas = backdropUrl ? await loadCoverTexture(backdropUrl) : null;
  if (!backdropAtlas) return null;
  const faceSize = extras.backdrop?.faceSize ?? (backdropAtlas.image as { height: number }).height / 2;
  const backdrop = makeColorCube(renderer, backdropAtlas, faceSize);
  backdropAtlas.dispose();

  // Shadow flags ride in each node's extras; a node with several primitives is a group of meshes.
  gltf.scene.traverse((object) => {
    const flags = object.userData as { castShadow?: boolean; receiveShadow?: boolean };
    if (flags.castShadow === undefined && flags.receiveShadow === undefined) return;
    object.traverse((child) => {
      child.castShadow = !!flags.castShadow;
      child.receiveShadow = !!flags.receiveShadow;
    });
  });
  configureLights(gltf.scene, eye);

  const scene = new Scene();
  // The world in its own coordinates, moved as a whole by `place`.
  const world = new Group();
  world.matrixAutoUpdate = false;
  world.add(gltf.scene);
  scene.add(world);
  if (extras.fog) {
    const color = new Color(...extras.fog.color);
    scene.fog = 'density' in extras.fog ? new FogExp2(color, extras.fog.density) : new Fog(color, extras.fog.near, extras.fog.far);
  }

  // Hemisphere lights shine from a direction, so they stay out of `world`
  // (which also moves things) and are only turned with it.
  const skyLights: Array<{ light: HemisphereLight; from: Vector3 }> = [];
  for (const ambient of extras.ambient ?? []) {
    if (ambient.type === 'ambient') {
      scene.add(new AmbientLight(new Color(...ambient.color), ambient.intensity));
    } else {
      const light = new HemisphereLight(new Color(...ambient.color), new Color(...(ambient.groundColor ?? [0, 0, 0])), ambient.intensity);
      const from = new Vector3(...(ambient.direction ?? [0, 1, 0])).normalize();
      light.position.copy(from);
      skyLights.push({ light, from });
      scene.add(light);
    }
  }

  const portal: LoadedPortal = {
    scene,
    backdrop: backdrop.texture,
    eyeHeight,
    shadowsDrawn: false,
    placement: world.matrix,
    place(doorMatrixWorld, spawnBehind) {
      world.matrix
        .copy(doorMatrixWorld)
        .multiply(new Matrix4().makeTranslation(0, eyeHeight, -spawnBehind))
        .multiply(new Matrix4().makeRotationY(-yaw))
        .multiply(new Matrix4().makeTranslation(-eye.x, -eye.y, -eye.z));
      world.matrixWorldNeedsUpdate = true;
      const turn = new Matrix4().extractRotation(world.matrix);
      for (const { light, from } of skyLights) light.position.copy(from).applyMatrix4(turn);
      portal.shadowsDrawn = false;
    },
    dispose() {
      scene.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        for (const material of ([] as Material[]).concat(mesh.material ?? [])) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
        (object as Light).shadow?.dispose();
      });
      backdrop.dispose();
    },
  };
  return portal;
}

/**
 * The scene's own lights (GLTFLoader made them from KHR_lights_punctual):
 * shadows as their nodes' extras say, and only the point and spot lights
 * nearest the arrival point.
 */
function configureLights(root: Object3D, eye: Vector3): void {
  const local: Array<{ light: Light; distance: number }> = [];
  root.traverse((object) => {
    const light = object as Light & { isPointLight?: boolean; isSpotLight?: boolean };
    if (!light.isLight) return;
    const shadow = (light.parent?.userData as { castShadow?: boolean; shadow?: PortalSceneShadow } | undefined)?.shadow;
    if (shadow && light.shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(shadow.mapSize, shadow.mapSize);
      light.shadow.bias = shadow.bias;
      light.shadow.normalBias = shadow.normalBias;
      Object.assign(light.shadow.camera, shadow.camera);
      (light.shadow.camera as unknown as { updateProjectionMatrix(): void }).updateProjectionMatrix();
    } else {
      light.castShadow = false;
    }
    if (light.isPointLight || light.isSpotLight) local.push({ light, distance: light.getWorldPosition(new Vector3()).distanceToSquared(eye) });
  });
  local.sort((a, b) => a.distance - b.distance);
  for (const { light } of local.slice(MAX_LOCAL_LIGHTS)) light.removeFromParent();
}

/** The file through the hub's same-origin relay (the bucket sends no CORS), else directly. */
async function fetchBuffer(src: string): Promise<ArrayBuffer | null> {
  const url = new URL(src, window.location.href);
  const candidates = url.origin !== window.location.origin ? [`/api/cover?url=${encodeURIComponent(url.toString())}`, url.toString()] : [url.toString()];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (response.ok) return await response.arrayBuffer();
    } catch {
      // Try the next source.
    }
  }
  return null;
}

import {
  AmbientLight,
  DirectionalLight,
  Fog,
  FogExp2,
  Group,
  HemisphereLight,
  Matrix4,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type CubeTexture,
  type Light,
  type Material,
  type Mesh,
  type WebGLRenderer,
} from 'three';
import type { PortalScene, PortalSceneLight } from '@worldmesh/runtime';
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
  /**
   * Stand the world behind a door: its spawn point `spawnBehind` metres back
   * from the doorway, facing out of it, its ground level with the floor.
   */
  place(doorMatrixWorld: Matrix4, spawnBehind: number): void;
  dispose(): void;
}

/** Point and spot lights kept, the nearest to the spawn point: each costs every pixel of the doorway. */
const MAX_LOCAL_LIGHTS = 8;

/** Load a portal scene listed in a door-view status; null if it won't load. */
export async function loadPortal(info: PortalScene, renderer: WebGLRenderer): Promise<LoadedPortal | null> {
  const [buffer, backdropAtlas, { GLTFLoader }] = await Promise.all([
    fetchBuffer(info.glb),
    loadCoverTexture(info.backdrop),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
  ]);
  if (!buffer || !backdropAtlas) {
    backdropAtlas?.dispose();
    return null;
  }
  let gltf: { scene: Group };
  try {
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch {
    backdropAtlas.dispose();
    return null;
  }
  const backdrop = makeColorCube(renderer, backdropAtlas, info.backdropFaceSize);
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

  const scene = new Scene();
  // The world in its own coordinates, moved as a whole by `place`.
  const world = new Group();
  world.matrixAutoUpdate = false;
  world.add(gltf.scene);
  scene.add(world);
  if (info.fog) {
    scene.fog = 'density' in info.fog ? new FogExp2(info.fog.color, info.fog.density) : new Fog(info.fog.color, info.fog.near, info.fog.far);
  }

  const eye = new Vector3(...info.eye);
  // Hemisphere lights shine from the direction of their position, so they stay
  // out of `world` (which also moves things) and are only turned with it.
  const skyLights: Array<{ light: HemisphereLight; from: Vector3 }> = [];
  for (const described of pickLights(info.lights, eye)) {
    const light = createLight(described);
    if (!light) continue;
    if (light instanceof HemisphereLight) {
      skyLights.push({ light, from: light.position.clone().normalize() });
      scene.add(light);
    } else if (light instanceof AmbientLight) {
      scene.add(light);
    } else {
      world.add(light);
      const aimed = light as DirectionalLight | SpotLight;
      if (aimed.target) world.add(aimed.target);
    }
  }

  const eyeHeight = info.eye[1] - info.feet[1];
  const portal: LoadedPortal = {
    scene,
    backdrop: backdrop.texture,
    eyeHeight,
    shadowsDrawn: false,
    place(doorMatrixWorld, spawnBehind) {
      world.matrix
        .copy(doorMatrixWorld)
        .multiply(new Matrix4().makeTranslation(0, eyeHeight, -spawnBehind))
        .multiply(new Matrix4().makeRotationY(-info.yaw))
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

/** Every light but point and spot lights past the nearest MAX_LOCAL_LIGHTS to the spawn point. */
function pickLights(lights: PortalSceneLight[], eye: Vector3): PortalSceneLight[] {
  const local = lights
    .filter((light) => light.type === 'point' || light.type === 'spot')
    .sort((a, b) => eye.distanceToSquared(new Vector3(...a.position)) - eye.distanceToSquared(new Vector3(...b.position)))
    .slice(0, MAX_LOCAL_LIGHTS);
  return lights.filter((light) => (light.type !== 'point' && light.type !== 'spot') || local.includes(light));
}

function createLight(described: PortalSceneLight): Light | null {
  let light: Light;
  switch (described.type) {
    case 'ambient':
      return new AmbientLight(described.color, described.intensity);
    case 'hemisphere':
      light = new HemisphereLight(described.color, described.groundColor ?? 0x000000, described.intensity);
      break;
    case 'directional':
      light = new DirectionalLight(described.color, described.intensity);
      break;
    case 'point':
      light = new PointLight(described.color, described.intensity, described.distance, described.decay);
      break;
    case 'spot':
      light = new SpotLight(described.color, described.intensity, described.distance, described.angle, described.penumbra, described.decay);
      break;
    default:
      return null;
  }
  light.position.set(...described.position);
  const aimed = light as DirectionalLight | SpotLight;
  if (described.target && aimed.target) aimed.target.position.set(...described.target);
  if (described.shadow && light.shadow) {
    const { mapSize, bias, normalBias, camera } = described.shadow;
    light.castShadow = true;
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.bias = bias;
    light.shadow.normalBias = normalBias;
    Object.assign(light.shadow.camera, camera);
    (light.shadow.camera as unknown as { updateProjectionMatrix(): void }).updateProjectionMatrix();
  }
  return light;
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

import {
  InstancedMesh,
  Mesh,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Fog,
  type FogExp2,
  type Light,
  type Material,
  type Object3D,
} from 'three';
import { captureDoorView, type DoorViewTarget } from './doorView.js';

/**
 * Portal scenes: what hub doors draw live, from wherever the visitor stands,
 * instead of a snapshot. The world's own meshes near its spawn point go into
 * a glTF file as they are; everything else (sky, far scenery, things glTF
 * can't hold) becomes a 360° backdrop photographed from the spawn point.
 * Far things barely shift as people move, so a photo serves them well.
 *
 * The file is a Doorway scene (docs/specs/doorway.md §3), readable by any
 * glTF loader: the arrival point is a node with OMI_spawn_point (facing its
 * −Z), directional, point and spot lights are KHR_lights_punctual, and what
 * has no standard yet rides in extras: the eye height on the spawn node, and
 * fog, ambient and sky light and the backdrop on the scene.
 */

/** Bumped when the layout of a portal scene changes. 2: everything inside the glTF (Doorway). */
export const PORTAL_SCENE_VERSION = 2;
/** The backdrop's file name next to the scene, as written in the scene's extras. */
export const PORTAL_BACKDROP_FILE = 'backdrop.webp';

export interface PortalSceneOptions {
  /** Meshes this close to the spawn point (metres) go into the 3D scene. Default 60. */
  radius?: number;
  /** Longest side of any texture in the 3D scene, in pixels. Default 1024. */
  maxTextureSize?: number;
  /** Pixels along one side of a backdrop face. Default 1024. */
  backdropFaceSize?: number;
  /** WebP quality of the backdrop, 0 to 1. Default 0.9. */
  quality?: number;
}

/** How a light casts shadows: in a light node's extras (`castShadow: true`, `shadow`). */
export interface PortalSceneShadow {
  mapSize: number;
  bias: number;
  normalBias: number;
  /** The shadow camera: an orthographic box for directional lights, near and far otherwise. */
  camera: { left?: number; right?: number; top?: number; bottom?: number; near: number; far: number };
}

/**
 * Light glTF has no standard for, in the scene's extras (`ambient`). Colours
 * are linear RGB 0–1. A hemisphere light shines from `direction`, relative to
 * the world, not to the arrival heading.
 */
export interface PortalSceneAmbient {
  type: 'ambient' | 'hemisphere';
  color: [number, number, number];
  intensity: number;
  groundColor?: [number, number, number];
  direction?: [number, number, number];
}

/** The scene's extras: what has no glTF standard yet. */
export interface PortalSceneExtras {
  /** Linear RGB 0–1. */
  fog?: { color: [number, number, number]; near: number; far: number } | { color: [number, number, number]; density: number };
  ambient?: PortalSceneAmbient[];
  /** The 3×2 cube-face atlas of everything further away, relative to the scene file. */
  backdrop?: { uri: string; faceSize: number };
}

export interface PortalScene {
  version: number;
  /**
   * The Doorway scene as a `data:model/gltf-binary` URL: the meshes near the
   * spawn point in world coordinates, the OMI_spawn_point node, the lights
   * (KHR_lights_punctual) and the scene extras above.
   */
  glb: string;
  /** Everything not in `glb`, a 3×2 cube-face atlas laid out like a door view's colour, as a `data:image/webp` URL. */
  backdrop: string;
  /** Meshes this close to the spawn point went into `glb`, metres. */
  radius: number;
  /** Triangles in `glb`, instances counted. */
  triangles: number;
}

export interface PortalSceneTarget extends DoorViewTarget {
  /** The player's feet at spawn. */
  feet: Vector3;
}

/** Materials glTF holds as they look (the rest would come out as something else). */
const EXPORTABLE = ['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial'];

/**
 * Export the portal scene. Stop the world's own render loop first: the
 * backdrop is taken like a door view, which resizes the canvas while it works.
 */
export async function exportPortal(target: PortalSceneTarget, options: PortalSceneOptions = {}): Promise<PortalScene> {
  const { scene, eye, feet } = target;
  const radius = options.radius ?? 60;
  const backdropFaceSize = options.backdropFaceSize ?? 1024;
  scene.updateMatrixWorld(true);

  const skip = new Set<Object3D>();
  for (const object of target.hide ?? []) object?.traverse((child) => skip.add(child));

  const reach = new Sphere(eye.clone(), radius);
  const bounds = new Sphere();
  const meshes: Mesh[] = [];
  // Near things glTF can't hold. Left out of the backdrop too: flattened onto
  // the sky they would hang in the wrong place.
  const dropped: Object3D[] = [];
  scene.traverseVisible((object) => {
    if (skip.has(object) || !worldBounds(object, bounds) || !bounds.intersectsSphere(reach)) return;
    const mesh = object as Mesh;
    if (mesh.isMesh && !(mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh && exportable(mesh.material)) meshes.push(mesh);
    else if (bounds.radius < radius) dropped.push(object);
  });

  const root = new Scene();
  let triangles = 0;
  for (const mesh of meshes) {
    const instanced = mesh as unknown as InstancedMesh;
    let copy: Mesh;
    if (instanced.isInstancedMesh) {
      const copied = new InstancedMesh(mesh.geometry, mesh.material, instanced.count);
      copied.instanceMatrix = instanced.instanceMatrix;
      copied.instanceColor = instanced.instanceColor;
      copy = copied;
    } else {
      copy = new Mesh(mesh.geometry, mesh.material);
    }
    // Flattened into world coordinates: the exporter writes each root's own transform.
    mesh.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    copy.name = mesh.name;
    copy.userData = { castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow };
    root.add(copy);
    triangles += countTriangles(mesh.geometry) * (instanced.isInstancedMesh ? instanced.count : 1);
  }

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exported = (await new GLTFExporter().parseAsync(root, {
    binary: true,
    maxTextureSize: options.maxTextureSize ?? 1024,
  })) as ArrayBuffer;
  const glb = withDoorway(exported, {
    feet,
    yaw: target.yaw,
    eyeHeight: eye.y - feet.y,
    lights: describeLights(scene, skip),
    extras: {
      ...(scene.fog ? { fog: describeFog(scene.fog) } : {}),
      ambient: describeAmbient(scene, skip),
      backdrop: { uri: PORTAL_BACKDROP_FILE, faceSize: backdropFaceSize },
    },
  });

  const backdrop = await captureDoorView(
    { ...target, hide: [...(target.hide ?? []), ...meshes, ...dropped] },
    { faceSize: backdropFaceSize, depthFaceSize: 8, quality: options.quality },
  );

  return {
    version: PORTAL_SCENE_VERSION,
    glb: await toDataUrl(glb, 'model/gltf-binary'),
    backdrop: backdrop.color,
    radius,
    triangles,
  };
}

function exportable(material: Material | Material[]): boolean {
  return (Array.isArray(material) ? material : [material]).every((m) => EXPORTABLE.includes(m.type));
}

/** World-space bounds of anything drawn with a geometry; false for everything else. */
function worldBounds(object: Object3D, out: Sphere): boolean {
  const drawn = object as Object3D & { geometry?: BufferGeometry; isInstancedMesh?: boolean; boundingSphere?: Sphere | null; computeBoundingSphere?: () => void };
  if (!drawn.geometry) return false;
  if (drawn.isInstancedMesh) {
    if (!drawn.boundingSphere) drawn.computeBoundingSphere?.();
    if (!drawn.boundingSphere) return false;
    out.copy(drawn.boundingSphere);
  } else {
    if (!drawn.geometry.boundingSphere) drawn.geometry.computeBoundingSphere();
    if (!drawn.geometry.boundingSphere) return false;
    out.copy(drawn.geometry.boundingSphere);
  }
  out.applyMatrix4(object.matrixWorld);
  return Number.isFinite(out.radius);
}

function countTriangles(geometry: BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
  return Math.floor(count / 3);
}

type Rgb = [number, number, number];
/** Linear RGB, as glTF and its extensions store colours. */
const linear = (color: { r: number; g: number; b: number }): Rgb => [color.r, color.g, color.b];

function describeFog(fog: NonNullable<Scene['fog']>): NonNullable<PortalSceneExtras['fog']> {
  if ((fog as FogExp2).isFogExp2) return { color: linear(fog.color), density: (fog as FogExp2).density };
  return { color: linear(fog.color), near: (fog as Fog).near, far: (fog as Fog).far };
}

function describeAmbient(scene: Scene, skip: Set<Object3D>): PortalSceneAmbient[] {
  const out: PortalSceneAmbient[] = [];
  scene.traverseVisible((object) => {
    const light = object as Light & Record<string, any>;
    if (!light.isLight || skip.has(light)) return;
    if (light.isAmbientLight) out.push({ type: 'ambient', color: linear(light.color), intensity: light.intensity });
    else if (light.isHemisphereLight) {
      const direction = light.getWorldPosition(new Vector3()).normalize().toArray() as Rgb;
      out.push({ type: 'hemisphere', color: linear(light.color), groundColor: linear(light.groundColor), intensity: light.intensity, direction });
    }
  });
  return out;
}

/** A directional, point or spot light, ready to become a KHR_lights_punctual light and its node. */
interface PunctualLight {
  light: Record<string, unknown>;
  position: Vector3;
  /** Where it points (its node's −Z); none for point lights. */
  target: Vector3 | null;
  shadow: PortalSceneShadow | null;
}

function describeLights(scene: Scene, skip: Set<Object3D>): PunctualLight[] {
  const lights: PunctualLight[] = [];
  scene.traverseVisible((object) => {
    const light = object as Light & Record<string, any>;
    if (!light.isLight || skip.has(light) || !(light.isDirectionalLight || light.isSpotLight || light.isPointLight)) return;
    const type = light.isDirectionalLight ? 'directional' : light.isSpotLight ? 'spot' : 'point';
    const described: Record<string, unknown> = { type, color: linear(light.color), intensity: light.intensity };
    if (!light.isDirectionalLight && light.distance > 0) described.range = light.distance;
    if (light.isSpotLight) {
      described.spot = { innerConeAngle: light.angle * (1 - light.penumbra), outerConeAngle: light.angle };
    }
    let target: Vector3 | null = null;
    if (light.target && !light.isPointLight) {
      light.target.updateMatrixWorld();
      target = light.target.getWorldPosition(new Vector3());
    }
    let shadow: PortalSceneShadow | null = null;
    if (light.castShadow && light.shadow) {
      const camera = light.shadow.camera as unknown as Record<'left' | 'right' | 'top' | 'bottom' | 'near' | 'far', number>;
      shadow = {
        mapSize: Math.max(light.shadow.mapSize.x, light.shadow.mapSize.y),
        bias: light.shadow.bias,
        normalBias: light.shadow.normalBias,
        camera: light.isDirectionalLight
          ? { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom, near: camera.near, far: camera.far }
          : { near: camera.near, far: camera.far },
      };
    }
    lights.push({ light: described, position: light.getWorldPosition(new Vector3()), target, shadow });
  });
  return lights;
}

/** A node rotation (glTF quaternion) that points the node's −Z from `from` toward `to`. */
function aim(from: Vector3, to: Vector3): number[] {
  const direction = to.clone().sub(from);
  if (direction.lengthSq() < 1e-12) return [0, 0, 0, 1];
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction.normalize()).toArray();
}

/**
 * Adds what makes the exported glTF a Doorway scene: the arrival point as an
 * OMI_spawn_point node, the lights as KHR_lights_punctual nodes, and the
 * scene extras. Edits the JSON chunk of the binary glTF; the buffers stay.
 */
function withDoorway(
  glb: ArrayBuffer,
  doorway: { feet: Vector3; yaw: number; eyeHeight: number; lights: PunctualLight[]; extras: PortalSceneExtras },
): ArrayBuffer {
  return editGlbJson(glb, (json) => {
    const nodes = (json.nodes ??= []) as Array<Record<string, unknown>>;
    const scenes = (json.scenes ??= [{ nodes: [] }]) as Array<{ nodes?: number[]; extras?: unknown }>;
    const scene = scenes[(json.scene as number | undefined) ?? 0];
    const roots = (scene.nodes ??= []);
    const used = new Set((json.extensionsUsed as string[] | undefined) ?? []);

    // The arrival point: feet at its translation, facing its −Z.
    roots.push(nodes.length);
    nodes.push({
      name: 'doorway-spawn',
      translation: doorway.feet.toArray(),
      rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), doorway.yaw).toArray(),
      extensions: { OMI_spawn_point: {} },
      extras: { eyeHeight: doorway.eyeHeight },
    });
    used.add('OMI_spawn_point');

    if (doorway.lights.length) {
      const lights = doorway.lights.map((punctual) => punctual.light);
      json.extensions = { ...(json.extensions as object), KHR_lights_punctual: { lights } };
      doorway.lights.forEach((punctual, index) => {
        roots.push(nodes.length);
        nodes.push({
          name: `doorway-light-${index}`,
          translation: punctual.position.toArray(),
          ...(punctual.target ? { rotation: aim(punctual.position, punctual.target) } : {}),
          extensions: { KHR_lights_punctual: { light: index } },
          ...(punctual.shadow ? { extras: { castShadow: true, shadow: punctual.shadow } } : {}),
        });
      });
      used.add('KHR_lights_punctual');
    }

    scene.extras = { ...(scene.extras as object), ...doorway.extras };
    json.extensionsUsed = [...used];
  });
}

/** Rewrites the JSON chunk of a binary glTF (GLB), keeping its binary chunk as it is. */
function editGlbJson(glb: ArrayBuffer, edit: (json: Record<string, any>) => void): ArrayBuffer {
  const view = new DataView(glb);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as Record<string, any>;
  edit(json);
  const rest = new Uint8Array(glb, 20 + jsonLength);
  let text = new TextEncoder().encode(JSON.stringify(json));
  // Chunks are 4-byte aligned; JSON pads with spaces.
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(12 + 8 + text.length + rest.length);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true); // "glTF"
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, text.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  out.set(rest, 20 + text.length);
  return out.buffer;
}

function toDataUrl(buffer: ArrayBuffer, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buffer], { type }));
  });
}

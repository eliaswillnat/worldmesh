import {
  InstancedMesh,
  Mesh,
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
 */

/** Bumped when the layout of a portal scene changes. */
export const PORTAL_SCENE_VERSION = 1;

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

export interface PortalSceneShadow {
  mapSize: number;
  bias: number;
  normalBias: number;
  /** The shadow camera: an orthographic box for directional lights, near and far otherwise. */
  camera: { left?: number; right?: number; top?: number; bottom?: number; near: number; far: number };
}

export interface PortalSceneLight {
  type: 'ambient' | 'hemisphere' | 'directional' | 'point' | 'spot';
  color: number;
  /** Hemisphere lights only. */
  groundColor?: number;
  intensity: number;
  /** World coordinates. A hemisphere light shines from this direction. */
  position: [number, number, number];
  /** Directional and spot lights: the point they aim at, world coordinates. */
  target?: [number, number, number];
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  shadow?: PortalSceneShadow;
}

export interface PortalScene {
  version: number;
  /**
   * The meshes near the spawn point as a `data:model/gltf-binary` URL, in
   * world coordinates. Each node's extras say whether it casts and receives
   * shadows. No lights: those are in `lights`.
   */
  glb: string;
  /** Everything not in `glb`, a 3×2 cube-face atlas laid out like a door view's colour, as a `data:image/webp` URL. */
  backdrop: string;
  backdropFaceSize: number;
  /** Where the player stands at spawn, world coordinates. */
  feet: [number, number, number];
  /** Where the backdrop was taken from: the player's eyes at spawn. */
  eye: [number, number, number];
  /** The spawn heading the backdrop's faces are relative to, in radians. */
  yaw: number;
  radius: number;
  fog: { color: number; near: number; far: number } | { color: number; density: number } | null;
  lights: PortalSceneLight[];
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
  const glb = (await new GLTFExporter().parseAsync(root, {
    binary: true,
    maxTextureSize: options.maxTextureSize ?? 1024,
  })) as ArrayBuffer;

  const backdrop = await captureDoorView(
    { ...target, hide: [...(target.hide ?? []), ...meshes, ...dropped] },
    { faceSize: backdropFaceSize, depthFaceSize: 8, quality: options.quality },
  );

  return {
    version: PORTAL_SCENE_VERSION,
    glb: await toDataUrl(glb, 'model/gltf-binary'),
    backdrop: backdrop.color,
    backdropFaceSize,
    feet: feet.toArray() as [number, number, number],
    eye: eye.toArray() as [number, number, number],
    yaw: target.yaw,
    radius,
    fog: describeFog(scene.fog),
    lights: describeLights(scene, skip),
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

function describeFog(fog: Scene['fog']): PortalScene['fog'] {
  if (!fog) return null;
  if ((fog as FogExp2).isFogExp2) return { color: fog.color.getHex(), density: (fog as FogExp2).density };
  return { color: fog.color.getHex(), near: (fog as Fog).near, far: (fog as Fog).far };
}

function describeLights(scene: Scene, skip: Set<Object3D>): PortalSceneLight[] {
  const lights: PortalSceneLight[] = [];
  const at = (object: Object3D) => object.getWorldPosition(new Vector3()).toArray() as [number, number, number];
  scene.traverseVisible((object) => {
    const light = object as Light & Record<string, any>;
    if (!light.isLight || skip.has(light)) return;
    const base = { color: light.color.getHex(), intensity: light.intensity, position: at(light) };
    if (light.isAmbientLight) lights.push({ type: 'ambient', ...base });
    else if (light.isHemisphereLight) lights.push({ type: 'hemisphere', ...base, groundColor: light.groundColor.getHex() });
    else if (light.isDirectionalLight || light.isSpotLight || light.isPointLight) {
      const type = light.isDirectionalLight ? 'directional' : light.isSpotLight ? 'spot' : 'point';
      const described: PortalSceneLight = { type, ...base };
      if (light.target) {
        light.target.updateMatrixWorld();
        described.target = at(light.target);
      }
      if (!light.isDirectionalLight) {
        described.distance = light.distance;
        described.decay = light.decay;
      }
      if (light.isSpotLight) {
        described.angle = light.angle;
        described.penumbra = light.penumbra;
      }
      if (light.castShadow && light.shadow) {
        const camera = light.shadow.camera as unknown as Record<'left' | 'right' | 'top' | 'bottom' | 'near' | 'far', number>;
        described.shadow = {
          mapSize: Math.max(light.shadow.mapSize.x, light.shadow.mapSize.y),
          bias: light.shadow.bias,
          normalBias: light.shadow.normalBias,
          camera: light.isDirectionalLight
            ? { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom, near: camera.near, far: camera.far }
            : { near: camera.near, far: camera.far },
        };
      }
      lights.push(described);
    }
  });
  return lights;
}

function toDataUrl(buffer: ArrayBuffer, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buffer], { type }));
  });
}

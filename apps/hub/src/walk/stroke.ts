import { BackSide, Mesh, MeshBasicMaterial, MeshToonMaterial, type Material, type Object3D } from 'three';

/** How far the shell sits outside the body, in metres. Thick enough to read as ink. */
const STROKE_WIDTH = 0.05;
/** Same ink as the door frames. Shown in both themes. */
const STROKE_COLOR = 0x1c1c1c;

/**
 * A cartoon outline around the default white figure. Each body part gets a
 * slightly larger shell of its back faces, so the ink shows only at the
 * silhouette. The drawn-on face is left alone.
 */
export function setFigureStroke(root: Object3D | null, enabled: boolean): void {
  if (!root) return;
  const strokes: Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof Mesh && child.userData.stroke === true) strokes.push(child);
  });
  if (!enabled) {
    const materials = new Set<Material>();
    for (const mesh of strokes) {
      if (!Array.isArray(mesh.material)) materials.add(mesh.material);
      mesh.removeFromParent();
    }
    for (const material of materials) material.dispose();
    return;
  }
  if (strokes.length > 0) return;

  const sources: Mesh[] = [];
  root.traverse((child) => {
    if (!(child instanceof Mesh) || child.userData.stroke === true) return;
    if (!(child.material instanceof MeshToonMaterial)) return;
    sources.push(child);
  });
  if (sources.length === 0) return;

  const sample = sources[0].material as MeshToonMaterial;
  const fading = sample.transparent;
  const material = new MeshBasicMaterial({
    color: STROKE_COLOR,
    side: BackSide,
    toneMapped: false,
    transparent: fading,
    opacity: fading ? sample.opacity : 1,
    depthWrite: sample.depthWrite,
  });
  material.userData.stroke = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  material.customProgramCacheKey = () => 'worldmesh-stroke';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\ntransformed += normalize(normal) * ${STROKE_WIDTH.toFixed(3)};`,
    );
  };

  for (const source of sources) {
    const stroke = new Mesh(source.geometry, material);
    stroke.name = 'worldmesh:stroke';
    stroke.userData.stroke = true;
    stroke.position.copy(source.position);
    stroke.quaternion.copy(source.quaternion);
    stroke.scale.copy(source.scale);
    stroke.castShadow = false;
    stroke.receiveShadow = false;
    stroke.raycast = () => {};
    source.parent?.add(stroke);
  }
}

/** Fade the outline with the figure. Shared across every part, so one write is enough. */
export function setStrokeOpacity(root: Object3D | null, amount: number): void {
  if (!root) return;
  const solid = amount >= 0.999;
  let material: MeshBasicMaterial | null = null;
  root.traverse((child) => {
    if (material || !(child instanceof Mesh) || child.userData.stroke !== true) return;
    if (child.material instanceof MeshBasicMaterial) material = child.material;
  });
  const stroke = material as MeshBasicMaterial | null;
  if (!stroke) return;
  stroke.transparent = !solid;
  stroke.opacity = amount;
  stroke.depthWrite = solid;
  stroke.needsUpdate = true;
}

export function isStrokeMaterial(material: Material): boolean {
  return material.userData.stroke === true;
}

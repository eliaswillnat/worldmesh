import {
  Color,
  FloatType,
  NoToneMapping,
  PerspectiveCamera,
  RGBAFormat,
  ShaderMaterial,
  DoubleSide,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

/**
 * A door view is what a hub door shows of a world: a 360° snapshot from the
 * spawn point, plus the distance to whatever each pixel shows, so the door can
 * shift near things against far ones as visitors walk past.
 *
 * Both images are 3×2 atlases of cube faces. Faces are in the spawn's own frame,
 * where -Z is the way the player faces at spawn, +Y is up and +X is to the right.
 * For face `i`, with forward F, up U and right R = F × U, the pixel at (u, v)
 * (v = 0 at the bottom) shows the direction F + (2u - 1)·R + (2v - 1)·U.
 * Face `i` sits in column `i % 3`, row `floor(i / 3)` counted from the top.
 */
export const DOOR_VIEW_FACES: ReadonlyArray<{ forward: [number, number, number]; up: [number, number, number] }> = [
  { forward: [1, 0, 0], up: [0, 1, 0] },
  { forward: [-1, 0, 0], up: [0, 1, 0] },
  { forward: [0, 1, 0], up: [0, 0, 1] },
  { forward: [0, -1, 0], up: [0, 0, -1] },
  { forward: [0, 0, 1], up: [0, 1, 0] },
  { forward: [0, 0, -1], up: [0, 1, 0] },
];

/** Bumped when the layout or the depth encoding changes. */
export const DOOR_VIEW_VERSION = 1;
/** Depth is stored as log(d / near) / log(far / near) in 16 bits, red high byte, green low byte. */
export const DOOR_VIEW_DEPTH_NEAR = 0.1;
export const DOOR_VIEW_DEPTH_FAR = 1000;

export interface DoorViewOptions {
  /** Pixels along one side of a colour face. Default 1024. */
  faceSize?: number;
  /** Pixels along one side of a depth face. Default 512. */
  depthFaceSize?: number;
  /** WebP quality of the colour atlas, 0 to 1. Default 0.9. */
  quality?: number;
}

export interface DoorView {
  version: number;
  /** Colour atlas as a `data:image/webp` URL. */
  color: string;
  /** Depth atlas as a `data:image/png` URL. Pixels that show sky decode to `depthFar`. */
  depth: string;
  faceSize: number;
  depthFaceSize: number;
  depthNear: number;
  depthFar: number;
  /** Where the snapshot was taken, in world coordinates. */
  eye: [number, number, number];
  /** The spawn heading the faces are relative to, in radians. */
  yaw: number;
}

export interface DoorViewTarget {
  scene: Scene;
  renderer: WebGLRenderer;
  /** Near and far are copied from this camera. */
  camera: { near: number; far: number };
  eye: Vector3;
  yaw: number;
  /** Hidden while the snapshot is taken, e.g. the player's own body. */
  hide?: Array<Object3D | null>;
}

const LOG_RANGE = Math.log(DOOR_VIEW_DEPTH_FAR / DOOR_VIEW_DEPTH_NEAR);

/**
 * Distance from the camera. `mvPosition` comes from three's own chunks, so
 * instanced, batched, skinned and morphed meshes land where they are drawn.
 */
function createDistanceMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vView;
      void main() {
        #include <batching_vertex>
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vView = mvPosition.xyz;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vView;
      void main() { gl_FragColor = vec4(length(vView), 0.0, 0.0, 1.0); }`,
  });
}

/**
 * Render the door view. Stop the world's own render loop first: this resizes
 * the canvas while it works and puts everything back afterwards.
 */
export async function captureDoorView(target: DoorViewTarget, options: DoorViewOptions = {}): Promise<DoorView> {
  const { scene, renderer, eye, yaw } = target;
  const faceSize = options.faceSize ?? 1024;
  const depthFaceSize = options.depthFaceSize ?? 512;
  const quality = options.quality ?? 0.9;

  const camera = new PerspectiveCamera(90, 1, target.camera.near, target.camera.far);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // The spawn frame turned by the player's heading, the same way three turns -Z into a camera's forward.
  const toWorld = (v: [number, number, number]) => new Vector3(v[0] * cos + v[2] * sin, v[1], -v[0] * sin + v[2] * cos);
  const aim = (face: (typeof DOOR_VIEW_FACES)[number]) => {
    camera.position.copy(eye);
    camera.up.copy(toWorld(face.up));
    camera.lookAt(toWorld(face.forward).add(eye));
    camera.updateMatrixWorld();
  };

  const saved = {
    size: renderer.getSize(new Vector2()),
    pixelRatio: renderer.getPixelRatio(),
    target: renderer.getRenderTarget(),
    xr: renderer.xr.enabled,
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
    override: scene.overrideMaterial,
    background: scene.background,
    hidden: (target.hide ?? []).filter((o): o is Object3D => !!o && o.visible),
  };
  for (const object of saved.hidden) object.visible = false;
  renderer.xr.enabled = false;

  const distance = createDistanceMaterial();
  const depthTarget = new WebGLRenderTarget(depthFaceSize, depthFaceSize, { type: FloatType, format: RGBAFormat, depthBuffer: true });
  try {
    // Colour: drawn to the canvas itself, so tone mapping and output colour match what visitors see.
    renderer.setPixelRatio(1);
    renderer.setSize(faceSize, faceSize, false);
    const color = document.createElement('canvas');
    color.width = faceSize * 3;
    color.height = faceSize * 2;
    const colorCtx = color.getContext('2d')!;
    DOOR_VIEW_FACES.forEach((face, i) => {
      aim(face);
      renderer.render(scene, camera);
      // Copy in the same task as the render, before the browser clears the drawing buffer.
      colorCtx.drawImage(renderer.domElement, 0, 0, faceSize, faceSize, (i % 3) * faceSize, Math.floor(i / 3) * faceSize, faceSize, faceSize);
    });

    // Depth: raw distances into a float target, read back and packed into 16 bits.
    scene.overrideMaterial = distance;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    const toneMapping = renderer.toneMapping;
    renderer.toneMapping = NoToneMapping;
    const hiddenSprites = hideUnsupported(scene);
    const depth = document.createElement('canvas');
    depth.width = depthFaceSize * 3;
    depth.height = depthFaceSize * 2;
    const depthCtx = depth.getContext('2d')!;
    const pixels = new Float32Array(depthFaceSize * depthFaceSize * 4);
    try {
      renderer.setRenderTarget(depthTarget);
      DOOR_VIEW_FACES.forEach((face, i) => {
        aim(face);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(depthTarget, 0, 0, depthFaceSize, depthFaceSize, pixels);
        depthCtx.putImageData(encodeDepth(pixels, depthFaceSize), (i % 3) * depthFaceSize, Math.floor(i / 3) * depthFaceSize);
      });
    } finally {
      renderer.toneMapping = toneMapping;
      for (const object of hiddenSprites) object.visible = true;
    }

    return {
      version: DOOR_VIEW_VERSION,
      color: color.toDataURL('image/webp', quality),
      depth: depth.toDataURL('image/png'),
      faceSize,
      depthFaceSize,
      depthNear: DOOR_VIEW_DEPTH_NEAR,
      depthFar: DOOR_VIEW_DEPTH_FAR,
      eye: eye.toArray() as [number, number, number],
      yaw,
    };
  } finally {
    depthTarget.dispose();
    distance.dispose();
    scene.overrideMaterial = saved.override;
    scene.background = saved.background;
    renderer.setRenderTarget(saved.target);
    renderer.setClearColor(saved.clearColor, saved.clearAlpha);
    renderer.setPixelRatio(saved.pixelRatio);
    renderer.setSize(saved.size.x, saved.size.y, false);
    renderer.xr.enabled = saved.xr;
    for (const object of saved.hidden) object.visible = true;
  }
}

/** Points and sprites have no surface for the distance material, so leave them out of the depth pass. */
function hideUnsupported(scene: Scene): Object3D[] {
  const hidden: Object3D[] = [];
  scene.traverseVisible((object) => {
    if ((object as { isPoints?: boolean }).isPoints || (object as { isSprite?: boolean }).isSprite) hidden.push(object);
  });
  for (const object of hidden) object.visible = false;
  return hidden;
}

/** Float distances (bottom row first) to an upright 16-bit log-depth image. Nothing drawn means sky. */
function encodeDepth(pixels: Float32Array, size: number): ImageData {
  const image = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size;
    for (let x = 0; x < size; x++) {
      const i = (src + x) * 4;
      const d = pixels[i + 3] > 0 ? pixels[i] : DOOR_VIEW_DEPTH_FAR;
      const t = Math.min(Math.max(Math.log(Math.max(d, DOOR_VIEW_DEPTH_NEAR) / DOOR_VIEW_DEPTH_NEAR) / LOG_RANGE, 0), 1);
      const q = Math.round(t * 65535);
      const o = (y * size + x) * 4;
      image.data[o] = q >> 8;
      image.data[o + 1] = q & 255;
      image.data[o + 2] = 0;
      image.data[o + 3] = 255;
    }
  }
  return image;
}

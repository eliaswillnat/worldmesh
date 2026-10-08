import {
  BackSide,
  BoxGeometry,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  RedFormat,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  type CubeTexture,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { DOOR_VIEW_DEPTH_FAR, DOOR_VIEW_DEPTH_NEAR } from '@worldmesh/runtime';

/**
 * Door views arrive as 3×2 atlases of cube faces (two images: colour and
 * depth). Doors sample them as real cube maps instead: those filter across
 * face edges without seams, and the depth comes out as plain distances in
 * half floats, smooth between pixels, with no decoding per sample.
 */
export interface DoorViewCubes {
  color: CubeTexture;
  /** Distance from the spawn point in metres, in the red channel. */
  depth: CubeTexture;
  dispose(): void;
}

/**
 * Face index and position on that face for direction d, in the layout of
 * DOOR_VIEW_FACES in @worldmesh/runtime: face i has forward F and up U, and
 * (u, v) shows the direction F + (2u - 1)·R + (2v - 1)·U, R = F × U.
 */
const FACE_GLSL = /* glsl */ `
  float viewFace(vec3 d, out vec2 uv) {
    vec3 a = abs(d);
    vec3 F;
    vec3 U;
    float face;
    if (a.x >= a.y && a.x >= a.z) {
      face = d.x > 0.0 ? 0.0 : 1.0;
      F = vec3(sign(d.x), 0.0, 0.0);
      U = vec3(0.0, 1.0, 0.0);
    } else if (a.y >= a.z) {
      face = d.y > 0.0 ? 2.0 : 3.0;
      F = vec3(0.0, sign(d.y), 0.0);
      U = vec3(0.0, 0.0, sign(d.y));
    } else {
      face = d.z > 0.0 ? 4.0 : 5.0;
      F = vec3(0.0, 0.0, sign(d.z));
      U = vec3(0.0, 1.0, 0.0);
    }
    vec3 R = cross(F, U);
    uv = vec2(dot(d, R), dot(d, U)) / dot(d, F) * 0.5 + 0.5;
    return face;
  }

  // Face column i % 3, row floor(i / 3) from the top. Kept half a pixel
  // inside the face so neighbouring faces never bleed in.
  vec2 atlasUv(float face, vec2 uv, float size) {
    uv = clamp(uv, 0.5 / size, 1.0 - 0.5 / size);
    float col = mod(face, 3.0);
    float row = floor(face / 3.0);
    return vec2((col + uv.x) / 3.0, 1.0 - (row + 1.0 - uv.y) / 2.0);
  }
`;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const colorFragment = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uSize;
  varying vec3 vDir;
  ${FACE_GLSL}
  void main() {
    vec2 uv;
    float face = viewFace(normalize(vDir), uv);
    gl_FragColor = vec4(texture2D(uAtlas, atlasUv(face, uv, uSize)).rgb, 1.0);
  }
`;

// Near things grow by a pixel (the nearest of the 3×3 around each pixel, on
// the same face), so the soft edge pixels of the colour image, part object
// and part background, move with the object instead of staying behind as a
// ghost outline.
const depthFragment = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uSize;
  varying vec3 vDir;
  ${FACE_GLSL}
  void main() {
    vec2 uv;
    float face = viewFace(normalize(vDir), uv);
    vec2 texel = (floor(clamp(uv, 0.0, 0.999999) * uSize) + 0.5) / uSize;
    float q = 1.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 n = texel + vec2(float(dx), float(dy)) / uSize;
        if (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) continue;
        vec4 t = texture2D(uAtlas, atlasUv(face, n, uSize));
        q = min(q, (t.r * 65280.0 + t.g * 255.0) / 65535.0);
      }
    }
    float distance = ${DOOR_VIEW_DEPTH_NEAR.toFixed(4)} * exp(q * ${Math.log(DOOR_VIEW_DEPTH_FAR / DOOR_VIEW_DEPTH_NEAR).toFixed(6)});
    gl_FragColor = vec4(distance, 0.0, 0.0, 1.0);
  }
`;

/** Whether this renderer can draw into half-float targets, which the depth cube needs. */
export function canMakeDoorViewCubes(renderer: WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

/**
 * Turn a door view's atlases into cube maps, on the GPU. The atlases are
 * only read here; the caller frees them afterwards. The colour atlas must be
 * loaded as sRGB, the depth atlas as exact data (no colour conversion,
 * nearest filtering).
 */
export function makeDoorViewCubes(
  renderer: WebGLRenderer,
  colorAtlas: Texture,
  depthAtlas: Texture,
  faceSize: number,
  depthFaceSize: number,
): DoorViewCubes {
  const color = new WebGLCubeRenderTarget(faceSize, { generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  color.texture.colorSpace = SRGBColorSpace;
  const depth = new WebGLCubeRenderTarget(depthFaceSize, {
    type: HalfFloatType,
    format: RedFormat,
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });

  const box = new BoxGeometry(2, 2, 2);
  const material = (fragmentShader: string, atlas: Texture, size: number) =>
    new ShaderMaterial({
      side: BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: { uAtlas: { value: atlas }, uSize: { value: size } },
      vertexShader,
      fragmentShader,
    });
  const colorMaterial = material(colorFragment, colorAtlas, faceSize);
  const depthMaterial = material(depthFragment, depthAtlas, depthFaceSize);
  const mesh = new Mesh(box, colorMaterial);
  const scene = new Scene();
  scene.add(mesh);

  const camera = new CubeCamera(0.1, 10, color);
  camera.update(renderer, scene);
  mesh.material = depthMaterial;
  camera.renderTarget = depth;
  camera.update(renderer, scene);

  box.dispose();
  colorMaterial.dispose();
  depthMaterial.dispose();

  return {
    color: color.texture,
    depth: depth.texture,
    dispose() {
      color.dispose();
      depth.dispose();
    },
  };
}

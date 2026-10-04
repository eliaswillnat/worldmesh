import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  NormalBlending,
  Points,
  ShaderMaterial,
  SkinnedMesh,
  Vector3,
  type Material,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { isStrokeMaterial } from '@worldmesh/runtime';

/**
 * A figure assembling out of thin air, in triplicate: three copies of it,
 * made only of points, form at the corners of a triangle round the spawn
 * point (points sampled over its surface fly in from the space around each,
 * swirling, feet first), then all three glide to the middle and merge, and
 * the real figure fades in where they meet. Works for any figure, the default one or a loaded
 * avatar, since it only reads its meshes.
 */

const COUNT = 4800;
/** How many copies form, and how far from the middle the triangle's corners are, in metres. */
const COPIES = 3;
const SPREAD = 0.15;
/** Seconds each point takes to fly in, and the most one waits before starting. */
const FLIGHT = 0.6;
const STAGGER = 0.45;
/** When the copies start gliding together, and how long that takes. */
const MERGE_FROM = 0.95;
const MERGE = 0.55;
/** When the real figure starts showing through, and how long the points linger after. */
const FIGURE_FROM = 1.25;
const LINGER = 0.3;
/** World size of a point, in metres. */
const POINT_SIZE = 0.036;
/** Longest step per frame, so a loading hitch slows the effect rather than skipping it. */
const MAX_STEP = 1 / 30;

/** Merged: the points have nowhere left to go. */
const END = MERGE_FROM + MERGE;

const vertexShader = /* glsl */ `
  uniform float uT;
  uniform float uScale;
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute float aDelay;
  attribute vec2 aOffset;
  uniform float uMerge;
  varying float vAlpha;

  void main() {
    float t = clamp((uT - aDelay) / ${FLIGHT.toFixed(3)}, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - t, 3.0);
    // Start and end are (radius, angle, height) round the figure's own axis,
    // so the points spiral in rather than fly straight.
    float r = mix(aStart.x, aEnd.x, e);
    float a = mix(aStart.y, aEnd.y, e);
    float y = mix(aStart.z, aEnd.z, 1.0 - pow(1.0 - t, 2.0));
    // Each copy forms round its own axis at a corner of the triangle, then glides to the middle.
    vec3 p = vec3(cos(a) * r, y, sin(a) * r);
    p.xz += aOffset * (1.0 - uMerge);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = ${POINT_SIZE.toFixed(3)} * uScale / max(-mv.z, 0.1) * mix(1.8, 1.0, e);
    // Unseen until their flight starts, then in quickly; gone after the hand-over.
    float linger = 1.0 - smoothstep(${END.toFixed(3)}, ${(END + LINGER).toFixed(3)}, uT);
    vAlpha = step(aDelay, uT) * smoothstep(0.0, 0.2, t) * linger;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float spot = 1.0 - smoothstep(0.15, 0.5, d);
    gl_FragColor = vec4(uColor, spot * vAlpha);
  }
`;

export class Assembly {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private target: (() => Object3D | null) | null = null;
  private time = 0;
  private active = false;
  private sampled: Object3D | null = null;
  /**
   * Where on the body each point belongs: a mesh, the point on it, and for a
   * skinned mesh the corner whose bones carry it. Looked up again every frame,
   * so the points follow the figure as it walks, turns and animates.
   */
  private anchors: Array<{ mesh: Mesh; local: Vector3; corner: number }> = [];
  /** Last angle of each point's spot round the figure, to keep its spiral from flipping round. */
  private angles = new Float32Array(COUNT);
  private readonly toRoot = new Matrix4();
  private readonly scratch = new Vector3();
  private readonly bind = new Vector3();
  private readonly skinned = new Vector3();

  constructor(layer?: number) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('aStart', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('aEnd', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    geometry.setAttribute('aDelay', new BufferAttribute(new Float32Array(COUNT), 1));
    geometry.setAttribute('aOffset', new BufferAttribute(new Float32Array(COUNT * 2), 2));
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uT: { value: 0 }, uMerge: { value: 0 }, uScale: { value: 800 }, uColor: { value: new Vector3(1, 1, 1) } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geometry, material);
    this.points.name = 'spawn-assembly';
    this.points.matrixAutoUpdate = false;
    this.points.frustumCulled = false;
    this.points.visible = false;
    if (layer !== undefined) this.points.layers.set(layer);
  }

  /** Assemble whatever figure `figure` returns (it may still be loading: it is asked again each frame). */
  start(figure: () => Object3D | null): void {
    this.target = figure;
    this.time = 0;
    this.active = true;
    this.sampled = null;
    this.points.visible = false;
  }

  /** White points on the dark hall, ink ones on the light hall. */
  setTheme(light: boolean): void {
    const material = this.points.material;
    (material.uniforms.uColor.value as Vector3).set(light ? 0.12 : 1, light ? 0.12 : 1, light ? 0.14 : 1);
    material.blending = light ? NormalBlending : AdditiveBlending;
    material.needsUpdate = true;
  }

  /**
   * Advance one frame. Returns how far the real figure has faded in (0–1)
   * while assembling, or null once done.
   */
  update(dt: number, camera: PerspectiveCamera, viewportHeight: number): number | null {
    if (!this.active || !this.target) return null;
    const root = this.target();
    if (!root) return 0;
    if (this.sampled !== root) {
      // Sample now, standing as it is: a new figure (a loaded avatar) starts over.
      if (!this.sample(root)) return 0;
      this.sampled = root;
      this.time = 0;
    }
    this.time += Math.min(Math.max(dt, 0), MAX_STEP);
    const points = this.points;
    points.visible = true;
    points.matrix.copy(root.matrixWorld);
    points.matrixWorld.copy(points.matrix);
    this.follow(root);
    const uniforms = points.material.uniforms;
    uniforms.uT.value = this.time;
    const merge = Math.min(1, Math.max(0, (this.time - MERGE_FROM) / MERGE));
    uniforms.uMerge.value = merge * merge * (3 - 2 * merge);
    uniforms.uScale.value = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (this.time >= END + LINGER) {
      this.active = false;
      points.visible = false;
      return 1;
    }
    const t = Math.min(1, Math.max(0, (this.time - FIGURE_FROM) / (END - FIGURE_FROM)));
    return t * t * (3 - 2 * t);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.removeFromParent();
  }

  /** Move every point's landing spot to where its piece of the body is now. */
  private follow(root: Object3D): void {
    root.updateMatrixWorld(true);
    this.toRoot.copy(root.matrixWorld).invert();
    const end = this.points.geometry.getAttribute('aEnd') as BufferAttribute;
    for (let i = 0; i < COUNT; i++) {
      const anchor = this.anchors[i % this.anchors.length];
      const point = this.locate(anchor, this.scratch).applyMatrix4(this.toRoot);
      let angle = Math.atan2(point.z, point.x);
      const last = this.angles[i];
      angle += Math.round((last - angle) / (Math.PI * 2)) * Math.PI * 2;
      this.angles[i] = angle;
      end.setXYZ(i, Math.hypot(point.x, point.z), angle, point.y);
    }
    end.needsUpdate = true;
  }

  /** Where an anchor's point is now, in world space. */
  private locate(anchor: { mesh: Mesh; local: Vector3; corner: number }, target: Vector3): Vector3 {
    target.copy(anchor.local);
    if (anchor.mesh instanceof SkinnedMesh) {
      // Carried as its triangle's first corner is carried by the bones.
      const positions = anchor.mesh.geometry.getAttribute('position');
      this.bind.fromBufferAttribute(positions, anchor.corner);
      this.skinned.copy(this.bind);
      anchor.mesh.applyBoneTransform(anchor.corner, this.skinned);
      target.add(this.skinned.sub(this.bind));
    }
    return target.applyMatrix4(anchor.mesh.matrixWorld);
  }

  /** Spread the points over the figure's surface, by area, and pick where each flies in from. */
  private sample(root: Object3D): boolean {
    root.updateMatrixWorld(true);
    const toRoot = new Matrix4().copy(root.matrixWorld).invert();
    const parts: Array<{ mesh: Mesh; sampler: MeshSurfaceSampler; area: number }> = [];
    root.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry?.getAttribute('position')) return;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
      // Outlines are inside-out copies of the body; the face is a decal. Neither is surface to fill.
      if (materials.every((material) => material.side === BackSide || isStrokeMaterial(material))) return;
      try {
        const sampler = new MeshSurfaceSampler(mesh).build();
        const distribution = (sampler as unknown as { distribution: Float32Array }).distribution;
        const scale = new Vector3().setFromMatrixScale(mesh.matrixWorld);
        const area = (distribution?.[distribution.length - 1] ?? 0) * Math.abs(scale.x * scale.y * scale.z) ** (2 / 3);
        if (area > 0) parts.push({ mesh, sampler, area });
      } catch {
        // A mesh the sampler cannot read: leave it out.
      }
    });
    const total = parts.reduce((sum, part) => sum + part.area, 0);
    if (!total) return false;

    const start = this.points.geometry.getAttribute('aStart') as BufferAttribute;
    const end = this.points.geometry.getAttribute('aEnd') as BufferAttribute;
    const delay = this.points.geometry.getAttribute('aDelay') as BufferAttribute;
    const offset = this.points.geometry.getAttribute('aOffset') as BufferAttribute;
    const point = new Vector3();
    const ends: Vector3[] = [];
    this.anchors = [];
    let top = 0;
    for (const part of parts) {
      const count = Math.round((COUNT * part.area) / total);
      const geometry = part.mesh.geometry;
      const index = geometry.index;
      for (let i = 0; i < count && ends.length < COUNT; i++) {
        // Present on the sampler, just missing from its type definitions.
        const face = (part.sampler as unknown as { sampleFaceIndex(): number }).sampleFaceIndex();
        part.sampler.sampleFace(face, point);
        const anchor = { mesh: part.mesh, local: point.clone(), corner: index ? index.getX(face * 3) : face * 3 };
        this.anchors.push(anchor);
        this.locate(anchor, point).applyMatrix4(toRoot);
        ends.push(point.clone());
        top = Math.max(top, point.y);
      }
    }
    for (let i = 0; i < COUNT; i++) {
      const target = ends[i % ends.length];
      const r1 = Math.hypot(target.x, target.z);
      const a1 = Math.atan2(target.z, target.x);
      // From further out, a turn or so back round the axis, mostly above.
      start.setXYZ(i, r1 + 1.2 + Math.random() * 2.2, a1 - 1.2 - Math.random() * 1.8, target.y + (Math.random() * 2.2 - 0.4));
      end.setXYZ(i, r1, a1, target.y);
      this.angles[i] = a1;
      // Feet first, a little scatter.
      delay.setX(i, (top > 0 ? target.y / top : 0) * (STAGGER - 0.15) + Math.random() * 0.15);
      // A corner of the triangle round the spawn point, one in front of the figure.
      const corner = ((i % COPIES) / COPIES) * Math.PI * 2;
      offset.setXY(i, Math.sin(corner) * SPREAD, Math.cos(corner) * SPREAD);
    }
    start.needsUpdate = true;
    end.needsUpdate = true;
    delay.needsUpdate = true;
    offset.needsUpdate = true;
    return true;
  }
}

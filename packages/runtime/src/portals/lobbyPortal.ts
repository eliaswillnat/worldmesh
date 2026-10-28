import {
  Color,
  FrontSide,
  Matrix4,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Material,
  type Scene,
  type WebGLRenderer,
} from 'three';

/**
 * The way back to the WorldMesh lobby: a quad, two triangles, that shows the
 * lobby live. It is the hub's live doors the other way round (Doorway,
 * docs/specs/doorway.md §3.1): the lobby runs in a frame under the world's
 * canvas, drawing itself from the visitor's camera, and the quad leaves its
 * pixels clear so the lobby shows through it, while anything standing in
 * front of it still covers it. Walking through it, front to back, goes to
 * the lobby, which brings the visitor out of this world's door there.
 *
 * Deliberately only a quad, so a world can dress it however it likes: frame
 * it with its own geometry, or hand over a two-triangle mesh of its own.
 *
 * A second page running costs about as much as the world, so the lobby is
 * loaded only near the quad, drawn only while close, in front of it and on
 * screen, and only the quad's part of the screen. The canvas must be made
 * with `alpha: true` for the lobby to show through; without it the quad
 * keeps its cover and still leads back.
 */

const VIEW_PARAM = 'doorway-view';
/** Load the lobby this close to the quad, in metres. */
const PRELOAD = 24;
/** Draw it live this close, and stop again past HIDE. */
const SHOW = 15;
const HIDE = 18;
/** Unload it past this. */
const UNLOAD = 30;
/** A lobby that hasn't said it's ready by then leaves the quad covered for the visit. */
const READY_TIMEOUT = 20;
/** Seconds the cover takes to fade into the live view, or back. */
const FADE = 0.4;
/** Margin round the quad's part of the screen: pixels, plus a share of its size (see the hub's liveDoors). */
const RECT_MARGIN = 4;
const RECT_SLACK = 0.08;
/** How far past the quad's sides and below its bottom edge walking through it still counts, in metres. */
const CROSS_MARGIN = 0.3;
/** Feet that moved further than this in a frame were put somewhere, not walked: they never cross it. */
const MAX_STRIDE = 2;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Written straight to the canvas (no blending), premultiplied: the cover at
 * full alpha, the live view as alpha 0, so the lobby's frame under the canvas
 * shows through. A world's own mesh keeps its own look as the cover.
 */
const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uLive;
uniform float uCover;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float glow = 1.0 - max(abs(p.x), abs(p.y));
  float drift = 0.5 + 0.5 * sin(uTime * 1.3 + vUv.y * 6.0);
  gl_FragColor = vec4(uColor * (0.45 + 0.3 * glow * drift), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  float cover = uCover * (1.0 - uLive);
  gl_FragColor = vec4(gl_FragColor.rgb * cover, cover);
}
`;

export interface LobbyPortalSetup {
  scene: Scene;
  renderer: WebGLRenderer;
  /** The lobby: drawn in the quad, and where walking through it leads. */
  url: string;
  /** The world's own quad, already in the scene. Otherwise one is made at `position`. */
  mesh?: Mesh;
  /** Bottom middle of the made quad. */
  position: Vector3;
  /** The way the made quad's front faces, radians about +Y (0 faces +Z). */
  yaw: number;
  width: number;
  height: number;
  color: number | string;
}

export class LobbyPortal {
  readonly url: string;
  /** The quad: the world's own, or the one made for it. */
  readonly mesh: Mesh;
  private own: boolean;
  /** A world's own mesh's material, shown while the lobby isn't. */
  private cover: Material | Material[] | null;
  private material: ShaderMaterial;
  private renderer: WebGLRenderer;
  /** The canvas can show what's under it: without alpha the quad keeps its cover. */
  private seeThrough: boolean;
  private layer: HTMLDivElement | null = null;
  /** Where the layer was last put (send), so it is only restyled when that changes. */
  private placed = '';
  private frame: HTMLIFrameElement | null = null;
  private origin = '';
  private ready = false;
  private framed = false;
  private failed = false;
  private showing = false;
  private timeout = 0;
  /** 0: covered, 1: the lobby in full. */
  private live = 0;
  /** The canvas's own `position` before it was lifted over the lobby's frame; null if untouched. */
  private canvasPosition: string | null = null;
  /** The feet last frame, in the quad's frame (+Z in front of it). */
  private last = new Vector3();
  private tracked = false;
  /** The quad's frame: its bottom middle at the origin, +Y up, its front facing +Z. */
  private door = new Matrix4();
  private inverse = new Matrix4();
  private measured = new Matrix4();
  private width = 0;
  private height = 0;

  constructor(setup: LobbyPortalSetup) {
    this.url = setup.url;
    this.renderer = setup.renderer;
    this.seeThrough = setup.renderer.getContextAttributes()?.alpha === true;
    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(setup.color) },
        uLive: { value: 0 },
        uCover: { value: setup.mesh ? 0 : 1 },
        uTime: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      blending: NoBlending,
      side: FrontSide,
    });
    if (setup.mesh) {
      this.mesh = setup.mesh;
      this.own = false;
      this.cover = setup.mesh.material;
    } else {
      const geometry = new PlaneGeometry(setup.width, setup.height);
      geometry.translate(0, setup.height / 2, 0);
      this.mesh = new Mesh(geometry, this.material);
      this.mesh.name = 'worldmesh:lobby-portal';
      this.mesh.position.copy(setup.position);
      this.mesh.rotation.y = setup.yaw;
      setup.scene.add(this.mesh);
      this.own = true;
      this.cover = null;
    }
    window.addEventListener('message', this.onMessage);
  }

  /**
   * Every frame, with the camera where it will be drawn from and the
   * visitor's feet: keep the lobby loaded near the quad, send it the camera
   * while it shows, fade the cover. True when the feet just went through the
   * quad from the front. `enabled` false (VR) covers it and lets the lobby go.
   */
  update(dt: number, camera: Camera, feet: Vector3, enabled: boolean): boolean {
    this.measure();
    this.material.uniforms.uTime.value += dt;
    const local = scratch.copy(feet).applyMatrix4(this.inverse);
    let crossed = false;
    const last = this.last;
    if (this.tracked && last.z > 0 && local.z <= 0 && last.distanceTo(local) < MAX_STRIDE) {
      // Where the feet went through the quad's plane.
      const t = last.z / (last.z - local.z);
      const x = last.x + (local.x - last.x) * t;
      const y = last.y + (local.y - last.y) * t;
      crossed = Math.abs(x) < this.width / 2 + CROSS_MARGIN && y > -CROSS_MARGIN && y < this.height;
    }
    last.copy(local);
    this.tracked = true;

    const distance = Math.hypot(local.x, local.z);
    const live = enabled && this.seeThrough && !this.failed && camera instanceof PerspectiveCamera;
    if (this.frame && (!live || distance > UNLOAD)) this.drop();
    if (!this.frame && live && distance < PRELOAD) this.load();

    let rect: Rect | null = null;
    if (this.frame && this.ready && camera instanceof PerspectiveCamera) {
      camera.updateMatrixWorld();
      // From behind, the quad isn't drawn at all.
      const facing = scratch.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inverse).z > 0;
      this.showing = facing && distance < (this.showing ? HIDE : SHOW);
      // Walked away, the lobby keeps drawing while the cover fades back over it.
      if (this.showing || this.live > 0) rect = this.screenRect(camera);
      if (rect) this.send(camera, rect);
    } else {
      this.showing = false;
    }
    // Off screen: only paused, it opens again at once.
    const target = this.showing && this.framed ? 1 : 0;
    if (rect || target === 0) this.live = target ? Math.min(1, this.live + dt / FADE) : Math.max(0, this.live - dt / FADE);
    this.material.uniforms.uLive.value = this.live;
    if (!this.own) this.mesh.material = this.live > 0 ? this.material : this.cover!;
    return crossed;
  }

  dispose(): void {
    this.drop();
    window.removeEventListener('message', this.onMessage);
    if (this.own) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
    } else {
      this.mesh.material = this.cover!;
    }
    this.material.dispose();
  }

  /**
   * The quad's frame, from its vertices in world space: its front is the
   * side its first triangle winds counter-clockwise on, its up is the
   * world's up laid flat on it. Worked out again only when it moves.
   */
  private measure(): void {
    const mesh = this.mesh;
    mesh.updateWorldMatrix(true, false);
    if (this.width > 0 && mesh.matrixWorld.equals(this.measured)) return;
    this.measured.copy(mesh.matrixWorld);
    const positions = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    if (!positions || positions.count < 3) return;
    const corner = (i: number, target: Vector3) =>
      target.fromBufferAttribute(positions, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    corner(0, a);
    corner(1, b);
    corner(2, c);
    normal.subVectors(b, a).cross(c.sub(a)).normalize();
    up.set(0, 1, 0).addScaledVector(normal, -normal.y);
    // Lying flat: its up is whichever way −Z falls on it.
    if (up.lengthSq() < 1e-4) up.set(0, 0, -1).addScaledVector(normal, normal.z);
    up.normalize();
    right.crossVectors(up, normal);
    let left = Infinity;
    let rightmost = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    let depth = 0;
    for (let i = 0; i < positions.count; i++) {
      a.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      const x = a.dot(right);
      const y = a.dot(up);
      left = Math.min(left, x);
      rightmost = Math.max(rightmost, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
      depth += a.dot(normal) / positions.count;
    }
    this.width = rightmost - left;
    this.height = top - bottom;
    a.copy(right).multiplyScalar((left + rightmost) / 2).addScaledVector(up, bottom).addScaledVector(normal, depth);
    this.door.makeBasis(right, up, normal).setPosition(a);
    this.inverse.copy(this.door).invert();
  }

  private load(): void {
    let src: URL;
    try {
      src = new URL(this.url, window.location.href);
    } catch {
      this.failed = true;
      return;
    }
    src.searchParams.set(VIEW_PARAM, '1');
    // The lobby draws itself from just inside this world's door.
    src.searchParams.set('from', window.location.origin + window.location.pathname);
    const canvas = this.renderer.domElement;
    const style = getComputedStyle(canvas);
    // Under the canvas, in the same stacking order: the frame goes just before
    // it, and a canvas left in the flow is positioned so it paints after.
    if (style.position === 'static') {
      this.canvasPosition = canvas.style.position;
      canvas.style.position = 'relative';
    }
    const layer = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { position: 'fixed', pointerEvents: 'none', overflow: 'hidden', zIndex: style.zIndex });
    const frame = document.createElement('iframe');
    frame.src = src.toString();
    frame.title = 'WorldMesh lobby';
    frame.tabIndex = -1;
    Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' });
    layer.append(frame);
    canvas.before(layer);
    this.layer = layer;
    this.frame = frame;
    this.origin = src.origin;
    this.ready = false;
    this.framed = false;
    this.timeout = window.setTimeout(() => {
      if (this.ready || this.frame !== frame) return;
      this.failed = true;
      this.drop();
    }, READY_TIMEOUT * 1000);
  }

  private drop(): void {
    window.clearTimeout(this.timeout);
    this.layer?.remove();
    this.layer = null;
    this.placed = '';
    this.frame = null;
    this.ready = false;
    this.framed = false;
    this.showing = false;
    this.live = 0;
    if (this.canvasPosition !== null) this.renderer.domElement.style.position = this.canvasPosition;
    this.canvasPosition = null;
  }

  /** The camera relative to the quad (the door frame, §3.1), and where the quad is on screen. */
  private send(camera: PerspectiveCamera, rect: Rect): void {
    const canvas = this.renderer.domElement;
    const box = canvas.getBoundingClientRect();
    const [left, top, right, bottom] = rect;
    // Over the canvas exactly, showing only the quad's part of it.
    const place = `${box.left} ${box.top} ${box.width} ${box.height} ${rect}`;
    if (place !== this.placed) {
      this.placed = place;
      Object.assign(this.layer!.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        clipPath: `inset(${top}px ${box.width - right}px ${box.height - bottom}px ${left}px)`,
      });
    }
    relative.copy(this.inverse).multiply(camera.matrixWorld);
    relative.decompose(position, quaternion, scale);
    this.frame!.contentWindow?.postMessage(
      {
        type: 'doorway:view',
        camera: { position: position.toArray(), quaternion: quaternion.toArray(), fov: camera.fov },
        viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
        rect,
      },
      this.origin,
    );
  }

  /**
   * Where the quad is on screen, as [left, top, right, bottom] in CSS pixels
   * from the canvas's top left; null if it is off screen. The whole canvas if
   * part of it is behind the camera.
   */
  private screenRect(camera: PerspectiveCamera): Rect | null {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    let left = Infinity;
    let bottom = Infinity;
    let right = -Infinity;
    let top = -Infinity;
    for (const [x, y] of [
      [-this.width / 2, 0],
      [this.width / 2, 0],
      [-this.width / 2, this.height],
      [this.width / 2, this.height],
    ]) {
      const corner = scratch.set(x, y, 0).applyMatrix4(this.door).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -camera.near) return [0, 0, width, height];
      corner.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, corner.x);
      right = Math.max(right, corner.x);
      bottom = Math.min(bottom, corner.y);
      top = Math.max(top, corner.y);
    }
    if (right < -1 || left > 1 || top < -1 || bottom > 1) return null;
    const margin = RECT_MARGIN + RECT_SLACK * Math.max(((right - left) / 2) * width, ((top - bottom) / 2) * height);
    return [
      Math.max(0, Math.floor(((left + 1) / 2) * width - margin)),
      Math.max(0, Math.floor(((1 - top) / 2) * height - margin)),
      Math.min(width, Math.ceil(((right + 1) / 2) * width + margin)),
      Math.min(height, Math.ceil(((1 - bottom) / 2) * height + margin)),
    ];
  }

  private onMessage = (event: MessageEvent): void => {
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'doorway:view-ready') {
      this.ready = true;
      window.clearTimeout(this.timeout);
    } else if (type === 'doorway:view-frame') {
      this.framed = true;
    }
  };
}

type Rect = [number, number, number, number];

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const normal = new Vector3();
const up = new Vector3();
const right = new Vector3();
const scratch = new Vector3();
const relative = new Matrix4();
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();

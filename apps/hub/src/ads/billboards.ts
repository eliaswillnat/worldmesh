import {
  BufferAttribute,
  CanvasTexture,
  Color,
  Frustum,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  ShaderMaterial,
  Sphere,
  Texture,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector4,
  VideoTexture,
  type BufferGeometry,
  type Camera,
  type Object3D,
  type Raycaster,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BillboardSlot } from '../walk/city';
import type { BillboardState, PublicAd } from './api';

/**
 * What the city's screens show. A billboard is one of:
 *
 *  - empty: a plain screen with a dashed outline and a "+" floating just in
 *    front, asking to be booked;
 *  - reserved: the outline without the "+", while someone's ad is in review;
 *  - an active advertisement: an image, or a muted looping video, with a
 *    small "Ad" label.
 *
 * Empty and reserved screens share two merged draw calls whatever their
 * number; each active ad is one more. Videos only decode while they are on
 * screen and near; everywhere else a video ad shows its still frame.
 */

/** Video ads start playing inside this distance, if on screen. */
const VIDEO_PLAY_DISTANCE = 70;
/** ...and give their decoder back beyond this distance, or after this long off screen. */
const VIDEO_UNLOAD_DISTANCE = 110;
const VIDEO_UNLOAD_AFTER = 8;
/** Decoding video is the expensive part; phones get fewer at once. */
const MAX_PLAYING_VIDEOS = { touch: 2, desktop: 4 };
/** How often visibility is re-checked, in seconds. Enough to feel instant, cheap to run. */
const VISIBILITY_INTERVAL = 0.25;
/** Longest texture side we upload. Bigger images only cost GPU memory. */
const MAX_TEXTURE = { touch: 1024, desktop: 2048 };
/** Empty-slot outlines fade out between these distances. */
const OUTLINE_FADE: [number, number] = [85, 190];

export type BillboardKind = 'empty' | 'reserved' | 'ad';

export interface BillboardHit {
  slot: BillboardSlot;
  kind: BillboardKind;
  ad?: PublicAd;
}

export interface AdBillboardsOptions {
  light: boolean;
  touch: boolean;
  maxTextureSize: number;
  anisotropy: number;
}

// ── Empty and reserved slots ─────────────────────────────────────────────────

const outlineVertex = /* glsl */ `
  attribute vec2 aSize;
  attribute float aSlot;
  attribute float aState;
  uniform float uFocus;
  uniform vec2 uFade;
  varying vec2 vUv;
  varying vec2 vSize;
  varying float vFocus;
  varying float vState;
  varying float vFade;
  varying float vSlot;

  void main() {
    vUv = uv;
    vSize = aSize;
    vState = aState;
    vSlot = aSlot;
    vFocus = abs(aSlot - uFocus) < 0.5 ? 1.0 : 0.0;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vFade = 1.0 - smoothstep(uFade.x, uFade.y, distance(world.xyz, cameraPosition));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const outlineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec2 vSize;
  varying float vFocus;
  varying float vState;
  varying float vFade;
  varying float vSlot;

  float band(float d, float halfWidth) {
    float aa = max(fwidth(d), 1e-4);
    return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, d);
  }

  void main() {
    // Work in metres from the screen's centre, so every size looks alike.
    vec2 c = (vUv - 0.5) * vSize;
    vec2 halfSize = vSize * 0.5;
    float small = min(vSize.x, vSize.y);
    float line = clamp(small * 0.012, 0.035, 0.08);
    float inset = clamp(small * 0.07, 0.2, 0.5);

    // A dashed rectangle just inside the screen's edge. The dashes crawl
    // around it while the slot is in focus.
    vec2 q = abs(c) - (halfSize - inset);
    float border = band(abs(max(q.x, q.y)), line * 0.5);
    float along = q.x > q.y ? c.y : c.x;
    float dashLength = clamp(small * 0.09, 0.28, 0.6);
    float dash = step(0.42, fract((along + vFocus * uTime * 0.5) / dashLength));
    float outline = border * dash;

    // A centred "+" (not on reserved slots), with a ring around it in focus.
    vec2 a = abs(c);
    float arm = small * 0.09 * (1.0 + 0.1 * vFocus);
    float bar = line * 0.8;
    float plus = max(band(a.y, bar) * band(a.x, arm), band(a.x, bar) * band(a.y, arm));
    float ring = band(abs(length(c) - arm * 1.7), line * 0.5) * vFocus;
    float mark = max(plus, ring * 0.85) * (1.0 - vState);

    float breathe = 0.85 + 0.15 * sin(uTime * 1.6 + vSlot * 1.3);
    float strength = mix(uOpacity * breathe, 1.0, vFocus) * mix(1.0, 0.5, vState);
    float alpha = max(outline, mark) * strength * vFade;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`;

// ── Advertisements ───────────────────────────────────────────────────────────

const adVertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const adFragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec2 uFit;
  uniform sampler2D uLabel;
  uniform vec4 uLabelRect;
  uniform vec3 uBackground;
  uniform float uFocus;
  varying vec2 vUv;

  void main() {
    // Letterbox: the whole advertisement is always visible, never cropped.
    vec2 q = (vUv - 0.5) * uFit + 0.5;
    vec3 color = uBackground;
    if (uHasMap > 0.5 && q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
      color = texture2D(uMap, q).rgb;
    }
    // The "Ad" label in the top-left corner.
    vec2 l = (vUv - uLabelRect.xy) / (uLabelRect.zw - uLabelRect.xy);
    if (l.x >= 0.0 && l.x <= 1.0 && l.y >= 0.0 && l.y <= 1.0) {
      vec4 label = texture2D(uLabel, l);
      color = mix(color, label.rgb, label.a);
    }
    color += uFocus * 0.06;
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function createLabelTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.beginPath();
  ctx.roundRect(2, 2, 124, 60, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 36px Urbanist, ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Ad', 64, 34);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A texture no larger than `max` on its longest side, from an image URL. */
async function loadImageTexture(url: string, max: number, anisotropy: number, signal: AbortSignal): Promise<Texture> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  let source: HTMLImageElement | HTMLCanvasElement = image;
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (longest > max) {
    const scale = max / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    source = canvas;
  }
  const texture = source instanceof HTMLCanvasElement ? new CanvasTexture(source) : new Texture(source);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** One active advertisement on one screen. */
class AdScreen {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private image: Texture | null = null;
  private video: HTMLVideoElement | null = null;
  private videoTexture: VideoTexture | null = null;
  private showingVideo = false;
  private abort = new AbortController();
  private disposed = false;
  /** Seconds this video has been off screen or far away. */
  offscreenFor = 0;
  readonly sphere: Sphere;

  constructor(
    readonly slot: BillboardSlot,
    readonly slotIndex: number,
    readonly ad: PublicAd,
    label: Texture,
    private options: AdBillboardsOptions,
  ) {
    const { width, height } = slot.plan;
    const labelW = Math.min(1.2, Math.max(0.5, width * 0.16));
    const labelH = labelW * 0.5;
    const margin = Math.min(0.25, width * 0.05);
    const material = new ShaderMaterial({
      vertexShader: adVertex,
      fragmentShader: adFragment,
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        uMap: { value: null },
        uHasMap: { value: 0 },
        uFit: { value: new Vector2(1, 1) },
        uLabel: { value: label },
        uLabelRect: {
          value: new Vector4(margin / width, 1 - (margin + labelH) / height, (margin + labelW) / width, 1 - margin / height),
        },
        uBackground: { value: new Color(0x000000) },
        uFocus: { value: 0 },
      },
      fog: true,
    });
    this.mesh = new Mesh(slot.geometry, material);
    this.mesh.name = `ad:${slot.plan.id}`;
    this.mesh.userData.slotIndex = slotIndex;
    this.sphere = new Sphere(slot.center.clone(), Math.hypot(width, height) / 2);
    // Images, and a video's still frame, are small enough to fetch right away.
    const still = ad.type === 'image' ? ad.mediaUrl : ad.posterUrl;
    if (still) {
      const max = Math.min(options.maxTextureSize, ad.type === 'image' ? this.maxTexture : 1024);
      loadImageTexture(still, max, options.anisotropy, this.abort.signal).then(
        (texture) => {
          if (this.disposed) return texture.dispose();
          this.image = texture;
          if (!this.showingVideo) this.show(texture, texture.image.width, texture.image.height);
        },
        () => {},
      );
    }
  }

  get isVideo(): boolean {
    return this.ad.type === 'video';
  }

  get playing(): boolean {
    return !!this.video && !this.video.paused;
  }

  private get maxTexture(): number {
    return this.options.touch ? MAX_TEXTURE.touch : MAX_TEXTURE.desktop;
  }

  setFocus(focus: boolean): void {
    this.mesh.material.uniforms.uFocus.value = focus ? 1 : 0;
  }

  /** Start (or resume) decoding and playing. Always muted. */
  play(): void {
    if (this.disposed || !this.isVideo) return;
    this.offscreenFor = 0;
    if (!this.video) this.video = this.createVideo();
    if (this.video.paused) this.video.play().catch(() => {});
  }

  pause(): void {
    if (this.video && !this.video.paused) this.video.pause();
  }

  /** Give the decoder and the video memory back; the still frame shows again. */
  unload(): void {
    const video = this.video;
    if (!video) return;
    this.video = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.videoTexture?.dispose();
    this.videoTexture = null;
    this.showingVideo = false;
    if (this.image) this.show(this.image, this.image.image.width, this.image.image.height);
    else this.clear();
  }

  private createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    // Muted, inline, looping, never with sound: set both properties and attributes,
    // because mobile browsers read the attributes to allow autoplay.
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.disableRemotePlayback = true;
    video.addEventListener('volumechange', () => {
      if (!video.muted || video.volume > 0) {
        video.muted = true;
        video.volume = 0;
      }
    });
    video.addEventListener('playing', () => {
      if (this.video !== video || this.disposed) return;
      if (!this.videoTexture) {
        this.videoTexture = new VideoTexture(video);
        this.videoTexture.colorSpace = SRGBColorSpace;
        this.videoTexture.minFilter = LinearFilter;
        this.videoTexture.generateMipmaps = false;
      }
      this.showingVideo = true;
      this.show(this.videoTexture, video.videoWidth, video.videoHeight);
    });
    video.src = this.ad.mediaUrl;
    return video;
  }

  private show(texture: Texture, width: number, height: number): void {
    const uniforms = this.mesh.material.uniforms;
    uniforms.uMap.value = texture;
    uniforms.uHasMap.value = 1;
    // Fit inside the screen: scale UVs so the longer relative side fills it.
    const screen = this.slot.plan.width / this.slot.plan.height;
    const media = width > 0 && height > 0 ? width / height : screen;
    uniforms.uFit.value.set(media > screen ? 1 : screen / media, media > screen ? media / screen : 1);
  }

  private clear(): void {
    this.mesh.material.uniforms.uMap.value = null;
    this.mesh.material.uniforms.uHasMap.value = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.unload();
    this.image?.dispose();
    this.image = null;
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}

export class AdBillboards {
  readonly group = new Group();
  private slots: BillboardSlot[] = [];
  private states = new Map<string, BillboardState>();
  private screens = new Map<string, AdScreen>();
  private surface: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  private outline: Mesh<BufferGeometry, ShaderMaterial> | null = null;
  private surfaceMaterial = new MeshBasicMaterial({ toneMapped: false });
  private outlineMaterial: ShaderMaterial;
  private label = createLabelTexture();
  private focus: number | null = null;
  private time = 0;
  private sinceCheck = VISIBILITY_INTERVAL;
  /** Wall-clock time of the last visibility check. Frame time is capped, so it can lag on slow devices. */
  private lastCheck = performance.now();
  private frustum = new Frustum();
  private projection = new Matrix4();
  private pageHidden = document.visibilityState === 'hidden';

  constructor(private options: AdBillboardsOptions) {
    this.group.name = 'billboards';
    this.outlineMaterial = new ShaderMaterial({
      vertexShader: outlineVertex,
      fragmentShader: outlineFragment,
      uniforms: {
        uColor: { value: new Color() },
        uTime: { value: 0 },
        uOpacity: { value: 0.4 },
        uFocus: { value: -1 },
        uFade: { value: new Vector2(...OUTLINE_FADE) },
      },
      transparent: true,
      depthWrite: false,
    });
    this.setTheme(options.light);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  /** The city was (re)built: these are its screens now. */
  setSlots(slots: BillboardSlot[]): void {
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
    this.slots = slots;
    this.focus = null;
    this.rebuild();
  }

  /** Fresh state from the server: which screens carry ads, and which are held. */
  setStates(states: BillboardState[]): void {
    const next = new Map(states.map((state) => [state.id, state]));
    const same =
      next.size === this.states.size &&
      [...next].every(([id, state]) => {
        const old = this.states.get(id);
        return old && old.state === state.state && old.ad?.id === state.ad?.id;
      });
    this.states = next;
    if (!same) this.rebuild();
  }

  setTheme(light: boolean): void {
    this.options.light = light;
    // A blank screen: dark glass at night, pale panel by day.
    this.surfaceMaterial.color.set(light ? 0xe3e6ec : 0x0f1116);
    this.outlineMaterial.uniforms.uColor.value.set(light ? 0x2a2d34 : 0xffffff);
    this.outlineMaterial.uniforms.uOpacity.value = light ? 0.5 : 0.42;
    for (const screen of this.screens.values()) {
      screen.mesh.material.uniforms.uBackground.value.set(light ? 0x111216 : 0x000000);
    }
  }

  /** Highlight one billboard (the one under the cursor, the crosshair or a finger). */
  setFocus(slot: BillboardSlot | null): void {
    const index = slot ? this.slots.indexOf(slot) : -1;
    const next = index >= 0 ? index : null;
    if (next === this.focus) return;
    this.focus = next;
    this.outlineMaterial.uniforms.uFocus.value = next ?? -1;
    for (const screen of this.screens.values()) screen.setFocus(screen.slotIndex === next);
  }

  /**
   * The billboard the ray hits first, if nothing solid is in the way.
   * `occluders` are the towers and walls.
   */
  pick(raycaster: Raycaster, occluders: Object3D[]): BillboardHit | null {
    const targets: Object3D[] = [...this.screens.values()].map((screen) => screen.mesh);
    if (this.surface) targets.push(this.surface);
    if (!targets.length) return null;
    const hit = raycaster.intersectObjects([...occluders, ...targets], false)[0];
    if (!hit || !targets.includes(hit.object)) return null;
    let index: number;
    if (hit.object === this.surface) {
      const attribute = this.surface.geometry.getAttribute('aSlot');
      index = hit.face ? attribute.getX(hit.face.a) : -1;
    } else {
      index = hit.object.userData.slotIndex as number;
    }
    const slot = this.slots[index];
    if (!slot) return null;
    const state = this.states.get(slot.plan.id);
    if (state?.state === 'active' && state.ad) return { slot, kind: 'ad', ad: state.ad };
    return { slot, kind: state ? 'reserved' : 'empty' };
  }

  /** Once per frame: animate the outlines, and decide which videos may decode. */
  update(dt: number, camera: Camera): void {
    this.time += dt;
    this.outlineMaterial.uniforms.uTime.value = this.time;
    this.sinceCheck += dt;
    if (this.sinceCheck < VISIBILITY_INTERVAL) return;
    this.sinceCheck = 0;
    const checkedAt = performance.now();
    const elapsed = Math.min(5, (checkedAt - this.lastCheck) / 1000);
    this.lastCheck = checkedAt;

    const videos = [...this.screens.values()].filter((screen) => screen.isVideo);
    if (!videos.length) return;
    camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    const eye = camera.position;

    const wanted: { screen: AdScreen; distance: number }[] = [];
    for (const screen of videos) {
      const distance = eye.distanceTo(screen.slot.center);
      // Only the front of a screen shows anything.
      const facing = screen.slot.normal.dot(eye.clone().sub(screen.slot.center)) > 0;
      const visible = !this.pageHidden && facing && this.frustum.intersectsSphere(screen.sphere);
      if (visible && distance < VIDEO_PLAY_DISTANCE) {
        wanted.push({ screen, distance });
      } else {
        screen.pause();
        screen.offscreenFor += elapsed;
        if (distance > VIDEO_UNLOAD_DISTANCE || screen.offscreenFor > VIDEO_UNLOAD_AFTER) screen.unload();
      }
    }
    // Nearest first; beyond the budget, pause (keep decoded frames briefly).
    wanted.sort((a, b) => a.distance - b.distance);
    const budget = this.options.touch ? MAX_PLAYING_VIDEOS.touch : MAX_PLAYING_VIDEOS.desktop;
    wanted.forEach(({ screen }, i) => {
      if (i < budget) screen.play();
      else {
        screen.pause();
        screen.offscreenFor += elapsed;
      }
    });
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibility);
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
    this.disposeMerged();
    this.surfaceMaterial.dispose();
    this.outlineMaterial.dispose();
    this.label.dispose();
    this.group.removeFromParent();
  }

  private handleVisibility = (): void => {
    this.pageHidden = document.visibilityState === 'hidden';
    if (this.pageHidden) for (const screen of this.screens.values()) screen.pause();
    // Re-check at once when the page comes back.
    this.sinceCheck = VISIBILITY_INTERVAL;
  };

  /** Rebuild the merged blank screens and outlines, and add or drop ad screens. */
  private rebuild(): void {
    this.disposeMerged();

    // Ad screens: keep the ones whose ad is unchanged, dispose the rest.
    const wanted = new Map<string, { slot: BillboardSlot; index: number; ad: PublicAd }>();
    this.slots.forEach((slot, index) => {
      const state = this.states.get(slot.plan.id);
      if (state?.state === 'active' && state.ad) wanted.set(slot.plan.id, { slot, index, ad: state.ad });
    });
    for (const [id, screen] of this.screens) {
      if (wanted.get(id)?.ad.id !== screen.ad.id) {
        screen.dispose();
        this.screens.delete(id);
      }
    }
    for (const [id, { slot, index, ad }] of wanted) {
      if (this.screens.has(id)) continue;
      const screen = new AdScreen(slot, index, ad, this.label, this.options);
      screen.mesh.material.uniforms.uBackground.value.set(this.options.light ? 0x111216 : 0x000000);
      screen.setFocus(index === this.focus);
      this.screens.set(id, screen);
      this.group.add(screen.mesh);
    }

    // Everything else is a blank screen with an outline.
    const surfaces: BufferGeometry[] = [];
    const outlines: BufferGeometry[] = [];
    this.slots.forEach((slot, index) => {
      if (wanted.has(slot.plan.id)) return;
      const reserved = this.states.has(slot.plan.id) ? 1 : 0;
      surfaces.push(withAttributes(slot.geometry, { aSlot: [index] }));
      outlines.push(
        withAttributes(slot.overlay, {
          aSlot: [index],
          aState: [reserved],
          aSize: [slot.plan.width, slot.plan.height],
        }),
      );
    });
    if (surfaces.length) {
      this.surface = new Mesh(mergeGeometries(surfaces), this.surfaceMaterial);
      this.surface.name = 'billboards:blank';
      this.outline = new Mesh(mergeGeometries(outlines), this.outlineMaterial);
      this.outline.name = 'billboards:outline';
      this.outline.renderOrder = 1;
      this.group.add(this.surface, this.outline);
    }
    for (const geometry of [...surfaces, ...outlines]) geometry.dispose();
  }

  private disposeMerged(): void {
    for (const mesh of [this.surface, this.outline]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    this.surface = null;
    this.outline = null;
  }
}

/** A copy of `geometry` with the same constant value on every vertex for each extra attribute. */
function withAttributes(geometry: BufferGeometry, attributes: Record<string, number[]>): BufferGeometry {
  const copy = geometry.clone();
  const count = copy.getAttribute('position').count;
  for (const [name, value] of Object.entries(attributes)) {
    const array = new Float32Array(count * value.length);
    for (let i = 0; i < count; i++) array.set(value, i * value.length);
    copy.setAttribute(name, new BufferAttribute(array, value.length));
  }
  return copy;
}

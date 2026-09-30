import { Color, Mesh, PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3, type Texture } from 'three';
import type { Assignment } from '../discovery/placement';
import { unitHash } from '../discovery/random';
import type { WorldListing } from '../worlds/listing';
import { BADGE_H, BADGE_ROWS, BADGE_W, CAPTION_H, CAPTION_W, STATUS_H, STATUS_ROWS, STATUS_W, tintFor, type CardCache, type WorldCard } from './cards';
import type { CityConfig } from './config';
import { PALETTES } from './materials';
import { ShutterMachine, type ShutterAudio } from './shutter';

/**
 * One physical door: a 9:16 screen in a tower wall showing a world's poster
 * or preview loop, its title and creator, an optional badge, and the
 * vertical shutter that drops whenever the door is reassigned. A door is a
 * view of a placement slot; it holds no ranking or placement logic.
 *
 * Doors are pooled: a floor streaming out hands its doors back, and the next
 * floor streaming in reuses their meshes and materials.
 */

const doorVertex = /* glsl */ `
  varying vec2 vUv;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const doorFragment = /* glsl */ `
  uniform sampler2D uPoster;
  uniform sampler2D uCaption;
  uniform sampler2D uVideo;
  uniform sampler2D uBadges;
  uniform sampler2D uStatus;
  uniform float uHasPoster;
  uniform float uHasCaption;
  uniform float uVideoMix;
  uniform vec2 uVideoFit;
  uniform float uAnim;
  uniform float uShutter;
  uniform float uStatusRow;
  uniform float uStatusAlpha;
  uniform float uBadgeRow;
  uniform float uFocus;
  uniform float uHighlight;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uTint;
  uniform vec3 uShutterColor;
  uniform vec3 uEdge;
  uniform float uCaptionH;
  uniform vec2 uBadgeSize;
  varying vec2 vUv;
  #include <common>
  #include <fog_pars_fragment>

  void main() {
    vec2 uv = vUv;

    // The world: its poster, slowly drifting while the door is animated.
    float t = uTime * 0.11 + uSeed * 6.2831;
    float zoom = 1.0 - 0.08 * uAnim * (0.5 + 0.5 * sin(t));
    vec2 pan = uAnim * 0.03 * vec2(sin(t * 0.7), cos(t * 0.53));
    vec2 puv = clamp((uv - 0.5) * zoom + 0.5 + pan, 0.0, 1.0);
    vec3 poster = texture2D(uPoster, puv).rgb;

    // No poster: light receding down a corridor in the world's tint.
    vec2 p = uv - 0.5;
    float depth = max(abs(p.x) * 2.0 / 0.56, abs(p.y) * 2.0);
    float bands = 0.5 + 0.5 * sin(9.0 / (depth + 0.15) - uTime * (0.6 + 1.6 * uAnim));
    vec3 corridor = mix(uTint * 0.1, uTint, bands * (1.0 - depth * 0.6));

    vec3 color = mix(corridor, poster, uHasPoster);
    vec2 vuv = (uv - 0.5) * uVideoFit + 0.5;
    color = mix(color, texture2D(uVideo, vuv).rgb, uVideoMix);

    // A slow sheen crossing an active door.
    float sweep = smoothstep(0.06, 0.0, abs(fract(uv.x * 0.6 + uv.y * 0.4 - uTime * 0.09) - 0.5)) * uAnim * 0.06;
    color += sweep;

    // Caption across the bottom, badge top left.
    if (uv.y < uCaptionH) {
      vec4 caption = texture2D(uCaption, vec2(uv.x, uv.y / uCaptionH));
      color = mix(color, caption.rgb, caption.a * uHasCaption);
    }
    if (uBadgeRow >= 0.0) {
      vec2 origin = vec2(0.055, 1.0 - 0.035 - uBadgeSize.y);
      vec2 local = (uv - origin) / uBadgeSize;
      if (local.x >= 0.0 && local.x <= 1.0 && local.y >= 0.0 && local.y <= 1.0) {
        vec4 badge = texture2D(uBadges, vec2(local.x, (${BADGE_ROWS.length.toFixed(1)} - 1.0 - uBadgeRow + local.y) / ${BADGE_ROWS.length.toFixed(1)}));
        color = mix(color, badge.rgb, badge.a);
      }
    }

    // Focus: the frame's inner edge brightens.
    float edge = max(abs(p.x) * 2.0, abs(p.y) * 2.0);
    color = mix(color, uEdge, smoothstep(0.93, 1.0, edge) * (0.25 * uFocus + 0.6 * uHighlight * (0.5 + 0.5 * sin(uTime * 5.0))));

    // The shutter, dropping from the top. Slats are fixed to the shutter, so they travel with it.
    float lip = 1.0 - uShutter;
    if (uShutter > 0.0005) {
      if (uv.y >= lip) {
        float local = (uv.y - lip) * 26.0;
        float slat = fract(local);
        float relief = 0.84 + 0.16 * smoothstep(0.0, 0.2, slat) * (1.0 - smoothstep(0.78, 1.0, slat));
        vec3 shutter = uShutterColor * relief;
        // A faint vertical seam down the middle.
        shutter *= 1.0 - 0.18 * smoothstep(0.006, 0.0, abs(p.x));
        if (uStatusRow >= 0.0 && uStatusAlpha > 0.0) {
          vec2 box = vec2(0.86, 0.86 * (${(STATUS_H / STATUS_W).toFixed(4)}) * (9.0 / 16.0));
          vec2 local2 = (uv - vec2(0.5 - box.x * 0.5, 0.5 - box.y * 0.5)) / box;
          if (local2.x >= 0.0 && local2.x <= 1.0 && local2.y >= 0.0 && local2.y <= 1.0) {
            float word = texture2D(uStatus, vec2(local2.x, (${STATUS_ROWS.length.toFixed(1)} - 1.0 - uStatusRow + local2.y) / ${STATUS_ROWS.length.toFixed(1)})).a;
            shutter = mix(shutter, uEdge, word * uStatusAlpha * 0.75);
          }
        }
        color = shutter;
      } else {
        // The shadow the shutter's edge throws on the world below it.
        color *= 1.0 - 0.4 * smoothstep(0.07, 0.0, lip - uv.y) * step(uShutter, 0.999);
      }
      // The lit leading edge.
      color += uEdge * smoothstep(0.009, 0.0, abs(uv.y - lip)) * 0.7;
    }

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export interface DoorResources {
  geometry: PlaneGeometry;
  badges: Texture;
  status: Texture;
  blank: Texture;
  cards: CardCache;
  config: CityConfig;
  audio: ShutterAudio;
}

export type PreviewTier = 'still' | 'animated' | 'active';

export class DoorView {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly center = new Vector3();
  /** Unit vector the door faces (into the tower). */
  readonly normal = new Vector3();
  slotId: string | null = null;
  towerId: string | null = null;
  floor = 0;
  angle = 0;
  /** What the door currently shows (not necessarily the slot's latest assignment). */
  listing: WorldListing | null = null;
  assignment: Assignment | null = null;
  readonly shutter: ShutterMachine;
  tier: PreviewTier = 'still';
  /** Highlight from search, in seconds left. */
  highlight = 0;
  private card: WorldCard | null = null;
  private pending: WorldCard | null = null;
  private animTarget = 0;
  private videoTarget = 0;
  private focusTarget = 0;
  private fallbackTint = '#8a8f99';

  constructor(private res: DoorResources) {
    this.shutter = new ShutterMachine(res.config.shutter, (cue) => res.audio.cue(cue, this.center), true);
    this.mesh = new Mesh(
      res.geometry,
      new ShaderMaterial({
        vertexShader: doorVertex,
        fragmentShader: doorFragment,
        uniforms: {
          ...UniformsUtils.clone(UniformsLib.fog),
          uPoster: { value: res.blank },
          uCaption: { value: res.blank },
          uVideo: { value: res.blank },
          uBadges: { value: res.badges },
          uStatus: { value: res.status },
          uHasPoster: { value: 0 },
          uHasCaption: { value: 0 },
          uVideoMix: { value: 0 },
          uVideoFit: { value: new Vector2(1, 1) },
          uAnim: { value: 0 },
          uShutter: { value: 1 },
          uStatusRow: { value: 1 },
          uStatusAlpha: { value: 1 },
          uBadgeRow: { value: -1 },
          uFocus: { value: 0 },
          uHighlight: { value: 0 },
          uTime: { value: 0 },
          uSeed: { value: 0 },
          uTint: { value: new Color() },
          uShutterColor: { value: new Color(PALETTES.dark.shutter) },
          uEdge: { value: new Color(0xfff4dc) },
          uCaptionH: { value: (CAPTION_H / CAPTION_W) * (9 / 16) },
          uBadgeSize: { value: new Vector2(0.44, 0.44 * (BADGE_H / BADGE_W) * (9 / 16)) },
        },
        fog: true,
      }),
    );
    this.mesh.name = 'door';
    this.mesh.matrixAutoUpdate = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  /** Open, showing a world, and safe to walk through. */
  get enterable(): boolean {
    return this.listing !== null && this.shutter.state === 'open';
  }

  /** Stand the door on the wall of a tower. */
  place(towerId: string, slotId: string, floor: number, angle: number, center: { x: number; z: number }, radius: number, y: number, tint: string): void {
    this.towerId = towerId;
    this.slotId = slotId;
    this.floor = floor;
    this.angle = angle;
    this.fallbackTint = tint;
    const { height } = this.res.geometry.parameters;
    this.center.set(center.x + Math.sin(angle) * radius, y + this.res.config.doorSill + height / 2, center.z + Math.cos(angle) * radius);
    this.normal.set(-Math.sin(angle), 0, -Math.cos(angle));
    this.mesh.position.copy(this.center);
    this.mesh.rotation.set(0, angle + Math.PI, 0);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
    this.uniforms.uSeed.value = unitHash(slotId);
  }

  /** Show a world (or nothing) at once, without the shutter: a door that just streamed in. */
  showNow(listing: WorldListing | null, assignment: Assignment | null): void {
    this.pending = null;
    this.apply(listing, assignment, listing ? this.res.cards.acquire(listing) : null);
    this.shutter.set(listing !== null);
    if (listing && this.card && !this.card.loaded) {
      const card = this.card;
      card.ready.then(() => {
        if (this.card === card) this.applyCard(card);
      });
    }
  }

  /** Swap to another world (or none) behind the shutter. */
  rotateTo(listing: WorldListing | null, assignment: Assignment | null, delay: number): void {
    if (this.pending) this.res.cards.release(this.pending.listingId);
    const card = listing ? this.res.cards.acquire(listing) : null;
    this.pending = card;
    this.shutter.cycle(
      () => {
        if (this.pending === card) this.pending = null;
        this.apply(listing, assignment, card);
      },
      { delay, waitForReady: card !== null && !card.loaded, stayClosed: listing === null },
    );
    card?.ready.then(() => {
      if (this.card === card || this.pending === card) {
        if (this.card === card) this.applyCard(card);
        this.shutter.markReady();
      }
    });
  }

  /** Same world, new placement details (e.g. a badge changed): no shutter needed. */
  updateAssignment(assignment: Assignment): void {
    this.assignment = assignment;
    this.uniforms.uBadgeRow.value = assignment.badge ? BADGE_ROWS.indexOf(assignment.badge) : -1;
  }

  setPreviewTier(tier: PreviewTier): void {
    this.tier = tier;
    this.animTarget = tier === 'active' ? 1 : tier === 'animated' ? 0.35 : 0;
  }

  setVideo(texture: Texture | null, width = 1, height = 1): void {
    if (texture) {
      this.uniforms.uVideo.value = texture;
      // Cover-crop the video to 9:16.
      const aspect = width / height;
      const door = 9 / 16;
      this.uniforms.uVideoFit.value.set(aspect > door ? door / aspect : 1, aspect > door ? 1 : aspect / door);
      this.videoTarget = 1;
    } else {
      this.videoTarget = 0;
    }
  }

  setFocus(focused: boolean): void {
    this.focusTarget = focused ? 1 : 0;
  }

  setTheme(light: boolean): void {
    this.uniforms.uShutterColor.value.set(PALETTES[light ? 'light' : 'dark'].shutter);
    this.uniforms.uEdge.value.set(light ? 0xffffff : 0xfff4dc);
  }

  update(dt: number, time: number): void {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uShutter.value = this.shutter.update(dt);
    const ease = 1 - Math.exp(-dt * 4);
    u.uAnim.value += (this.animTarget - u.uAnim.value) * ease;
    u.uFocus.value += (this.focusTarget - u.uFocus.value) * ease;
    u.uVideoMix.value += (this.videoTarget - u.uVideoMix.value) * (1 - Math.exp(-dt * 5));
    if (this.videoTarget === 0 && u.uVideoMix.value < 0.01 && u.uVideo.value !== this.res.blank) {
      u.uVideoMix.value = 0;
      u.uVideo.value = this.res.blank;
    }
    // "REASSIGNING" only once fully shut during a swap; "OPEN SLOT" while empty.
    const shut = this.shutter.state === 'closed';
    u.uStatusRow.value = this.listing ? 0 : 1;
    u.uStatusAlpha.value += ((shut ? 1 : 0) - u.uStatusAlpha.value) * (1 - Math.exp(-dt * 6));
    if (this.highlight > 0) this.highlight = Math.max(0, this.highlight - dt);
    u.uHighlight.value = this.highlight > 0 ? Math.min(1, this.highlight) : 0;
  }

  /** Hand the door back to the pool. */
  release(): void {
    if (this.card) this.res.cards.release(this.card.listingId);
    if (this.pending) this.res.cards.release(this.pending.listingId);
    this.card = null;
    this.pending = null;
    this.listing = null;
    this.assignment = null;
    this.slotId = null;
    this.towerId = null;
    this.highlight = 0;
    this.setVideo(null);
    this.uniforms.uVideoMix.value = 0;
    this.uniforms.uVideo.value = this.res.blank;
    this.setPreviewTier('still');
    this.uniforms.uAnim.value = 0;
    this.setFocus(false);
    this.mesh.removeFromParent();
  }

  dispose(): void {
    this.release();
    this.mesh.material.dispose();
  }

  private apply(listing: WorldListing | null, assignment: Assignment | null, card: WorldCard | null): void {
    if (this.card && this.card !== card) this.res.cards.release(this.card.listingId);
    this.card = card;
    this.listing = listing;
    this.assignment = assignment;
    const u = this.uniforms;
    u.uTint.value.copy(tintFor(listing, this.fallbackTint));
    u.uBadgeRow.value = assignment?.badge ? BADGE_ROWS.indexOf(assignment.badge) : -1;
    if (card) this.applyCard(card);
    else {
      u.uPoster.value = this.res.blank;
      u.uCaption.value = this.res.blank;
      u.uHasPoster.value = 0;
      u.uHasCaption.value = 0;
    }
  }

  private applyCard(card: WorldCard): void {
    const u = this.uniforms;
    u.uPoster.value = card.poster ?? this.res.blank;
    u.uHasPoster.value = card.poster ? 1 : 0;
    u.uCaption.value = card.caption;
    u.uHasCaption.value = 1;
  }
}

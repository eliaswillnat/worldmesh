import { LinearFilter, SRGBColorSpace, Vector3, VideoTexture, type PerspectiveCamera } from 'three';
import type { Analytics } from '../analytics/analytics';
import type { CityConfig } from './config';
import type { DoorView } from './doorView';

/**
 * Decides which doors animate and which few play video. Doors never start
 * playback themselves.
 *
 *   far or out of view   still poster
 *   in view, near-ish    poster drifts (a shader effect, free)
 *   best few, close      preview loop plays, if the world has one;
 *                        otherwise a livelier drift
 *
 * Video elements come from a fixed pool of `maxActiveVideos`, are muted and
 * inline, and give their source back after a few seconds out of view, so
 * decoding never scales with the number of doors.
 */

interface VideoSlot {
  video: HTMLVideoElement;
  texture: VideoTexture;
  door: DoorView | null;
  listingId: string | null;
  idle: number;
  lastTime: number;
  completed: boolean;
}

export interface PreviewStats {
  animated: number;
  active: number;
  playing: number;
}

export class DoorPreviewManager {
  private slots: VideoSlot[] = [];
  private failed = new Set<string>();
  private forward = new Vector3();
  private toDoor = new Vector3();
  private sinceUpdate = 0;
  private hidden = document.visibilityState === 'hidden';
  private started = new Set<string>();
  stats: PreviewStats = { animated: 0, active: 0, playing: 0 };
  private maxActive: number;

  constructor(
    private config: CityConfig,
    private analytics: Analytics,
    touch: boolean,
  ) {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.maxActive = saveData || reduced ? 0 : touch ? config.maxActiveVideosMobile : config.maxActiveVideos;
    for (let i = 0; i < this.maxActive; i++) this.slots.push(this.createSlot());
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  get maxActiveVideos(): number {
    return this.maxActive;
  }

  /** Call every frame with the doors that could be seen. Work is throttled internally. */
  update(dt: number, doors: readonly DoorView[], camera: PerspectiveCamera): void {
    for (const slot of this.slots) {
      if (slot.door && slot.door.slotId === null) this.releaseSlot(slot);
    }
    this.sinceUpdate += dt;
    if (this.sinceUpdate < 0.2) return;
    const elapsed = this.sinceUpdate;
    this.sinceUpdate = 0;

    camera.getWorldDirection(this.forward);
    const halfFov = ((camera.fov * Math.PI) / 180) * 0.5 * Math.max(1, camera.aspect);
    const inViewCos = Math.cos(Math.min(Math.PI * 0.49, halfFov * 1.1));
    const candidates: { door: DoorView; score: number }[] = [];
    let animated = 0;
    for (const door of doors) {
      if (!door.mesh.visible || !door.listing) {
        door.setPreviewTier('still');
        continue;
      }
      this.toDoor.subVectors(door.center, camera.position);
      const distance = this.toDoor.length();
      this.toDoor.divideScalar(distance || 1);
      const facing = this.toDoor.dot(this.forward);
      // Doors face into the tower; one seen from behind is not in view.
      const front = -this.toDoor.dot(door.normal);
      const inView = facing > inViewCos && front > 0.05;
      if (!inView || distance > this.config.animationDistance || !door.enterable) {
        door.setPreviewTier('still');
        continue;
      }
      animated++;
      const score = (1 - distance / this.config.animationDistance) * 0.6 + facing * 0.3 + front * 0.1;
      if (distance < this.config.videoActivationDistance) candidates.push({ door, score });
      else door.setPreviewTier('animated');
    }
    candidates.sort((a, b) => b.score - a.score);

    // The best few are active; everyone else in range just drifts.
    const active = new Set<DoorView>();
    for (const { door } of candidates) {
      if (active.size < Math.max(1, this.maxActive)) active.add(door);
      else door.setPreviewTier('animated');
    }
    for (const door of active) {
      if (door.tier !== 'active') {
        const kind = door.listing!.preview?.length && !this.failed.has(door.listing!.id) && this.maxActive > 0 ? 'video' : 'animated';
        const key = `${door.slotId}/${door.listing!.id}`;
        if (!this.started.has(key)) {
          this.started.add(key);
          this.analytics.track('preview_started', { listingId: door.listing!.id, slotId: door.slotId!, kind });
        }
      }
      door.setPreviewTier('active');
    }

    // Hand video slots to active doors with a preview, best first.
    const wantsVideo = [...active].filter((door) => door.listing?.preview?.length && !this.failed.has(door.listing.id));
    for (const slot of this.slots) {
      if (slot.door && (!wantsVideo.includes(slot.door) || slot.listingId !== slot.door.listing?.id)) {
        slot.door.setVideo(null);
        slot.video.pause();
        slot.door = null;
      }
      if (!slot.door) {
        slot.idle += elapsed;
        if (slot.listingId && slot.idle > this.config.videoReleaseS) this.unload(slot);
      }
    }
    if (!this.hidden) {
      for (const door of wantsVideo) {
        if (this.slots.some((slot) => slot.door === door)) continue;
        const slot = this.slots.find((candidate) => !candidate.door && candidate.listingId === door.listing!.id) ?? this.slots.find((candidate) => !candidate.door);
        if (!slot) break;
        this.play(slot, door);
      }
    }
    this.stats = { animated, active: active.size, playing: this.slots.filter((slot) => slot.door && !slot.video.paused).length };
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibility);
    for (const slot of this.slots) {
      this.unload(slot);
      slot.texture.dispose();
    }
    this.slots = [];
  }

  private createSlot(): VideoSlot {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.crossOrigin = 'anonymous';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    const slot: VideoSlot = { video, texture, door: null, listingId: null, idle: 0, lastTime: 0, completed: false };
    video.addEventListener('playing', () => {
      if (slot.door) slot.door.setVideo(texture, video.videoWidth || 9, video.videoHeight || 16);
    });
    video.addEventListener('timeupdate', () => {
      // A loop wraps: count one full watch per activation.
      if (slot.door && !slot.completed && video.currentTime + 0.25 < slot.lastTime) {
        slot.completed = true;
        this.analytics.track('preview_completed', { listingId: slot.listingId!, slotId: slot.door.slotId! });
      }
      slot.lastTime = video.currentTime;
    });
    video.addEventListener('error', () => {
      if (slot.listingId) this.failed.add(slot.listingId);
      slot.door?.setVideo(null);
      slot.door = null;
    });
    return slot;
  }

  private play(slot: VideoSlot, door: DoorView): void {
    const listing = door.listing!;
    slot.door = door;
    slot.idle = 0;
    slot.completed = false;
    if (slot.listingId !== listing.id) {
      slot.listingId = listing.id;
      slot.lastTime = 0;
      slot.video.replaceChildren(
        ...listing.preview!.map((media) => {
          const source = document.createElement('source');
          source.src = media.src;
          if (media.type) source.type = media.type;
          return source;
        }),
      );
      slot.video.load();
    } else if (!slot.video.paused && slot.video.readyState >= 2) {
      door.setVideo(slot.texture, slot.video.videoWidth || 9, slot.video.videoHeight || 16);
    }
    slot.video.play().catch(() => {
      // Autoplay refused (rare for muted video): the poster keeps drifting.
    });
  }

  private releaseSlot(slot: VideoSlot): void {
    slot.video.pause();
    slot.door = null;
  }

  /** Give the decoder back: no source until the next assignment. */
  private unload(slot: VideoSlot): void {
    slot.video.pause();
    slot.video.replaceChildren();
    slot.video.removeAttribute('src');
    slot.video.load();
    slot.listingId = null;
    slot.idle = 0;
  }

  private handleVisibility = () => {
    this.hidden = document.visibilityState === 'hidden';
    if (this.hidden) for (const slot of this.slots) slot.video.pause();
  };
}

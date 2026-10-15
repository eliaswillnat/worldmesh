import type { AvatarDescriptor } from './descriptor.js';
import type { SharedAvatar } from '../net/presence.js';

/**
 * Which avatar other players may see, and keeping its link fresh.
 *
 * Other players download the model straight from the platform, like the
 * visitor's own browser did. Two things stand in the way:
 *
 * - VRoid Hub licenses a download to the user who asked for it. Showing it to
 *   other players needs VRoid's "Multiplay" approval, which WorldMesh does not
 *   have yet, so VRoid avatars stay visible to their owner only.
 * - Some links expire within minutes (Sketchfab's presigned URLs). Someone
 *   joining later needs a fresh one, so the owner asks for a new link shortly
 *   before the old one runs out. Peers that already loaded the model keep it.
 */

/** Providers whose avatars must not be shown to other players. */
const PRIVATE_PROVIDERS: readonly string[] = ['vroid'];
/** Ask for a new link this long before the old one expires. */
const REFRESH_EARLY_MS = 45_000;
const MIN_REFRESH_MS = 30_000;

/** The avatar as it may go to other players, or null when it must not (or cannot) be shared. */
export function shareableAvatar(descriptor: AvatarDescriptor | null): SharedAvatar | null {
  if (!descriptor || PRIVATE_PROVIDERS.includes(descriptor.provider)) return null;
  if (!descriptor.modelUrl.startsWith('https:')) return null;
  return { url: descriptor.modelUrl, format: descriptor.format, id: avatarKey(descriptor) };
}

/** Same avatar, possibly a different link. */
function sameAvatar(a: AvatarDescriptor, b: AvatarDescriptor): boolean {
  return avatarKey(a) === avatarKey(b);
}

/**
 * A short stable id for an avatar, so peers can tell a new link to the same
 * model from a different model. Hashed, so the platform's own id is not sent.
 */
function avatarKey(descriptor: AvatarDescriptor): string {
  const source = descriptor.avatarId ? `${descriptor.provider}:${descriptor.avatarId}` : descriptor.modelUrl;
  return fnv(source, 0x811c9dc5).toString(36) + fnv(source, 0x01000193).toString(36);
}

function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The avatar this visitor shows other players. Set it whenever the local
 * avatar changes; when its link expires and `resolve` can fetch a new one, it
 * keeps the shared link current.
 */
export class SharedAvatarLink {
  private descriptor: AvatarDescriptor | null = null;
  private shared: SharedAvatar | null = null;
  private timer = 0;
  private turn = 0;

  constructor(private resolve: (() => Promise<AvatarDescriptor | null>) | null) {}

  set(descriptor: AvatarDescriptor | null): void {
    this.turn += 1;
    window.clearTimeout(this.timer);
    this.descriptor = descriptor;
    this.shared = shareableAvatar(descriptor);
    this.schedule();
  }

  get(): SharedAvatar | null {
    return this.shared;
  }

  dispose(): void {
    this.turn += 1;
    window.clearTimeout(this.timer);
    this.resolve = null;
  }

  private schedule(): void {
    const descriptor = this.descriptor;
    if (!this.resolve || !this.shared || !descriptor?.expiresAt) return;
    const expires = Date.parse(descriptor.expiresAt);
    if (!Number.isFinite(expires)) return;
    const delay = Math.max(MIN_REFRESH_MS, expires - Date.now() - REFRESH_EARLY_MS);
    const turn = this.turn;
    this.timer = window.setTimeout(() => void this.refresh(turn), delay);
  }

  private async refresh(turn: number): Promise<void> {
    if (turn !== this.turn || !this.resolve) return;
    // Nobody new sees a hidden tab's link expire; ask again once it is back.
    if (document.hidden) {
      this.timer = window.setTimeout(() => void this.refresh(turn), MIN_REFRESH_MS);
      return;
    }
    let fresh: AvatarDescriptor | null = null;
    try {
      fresh = await this.resolve();
    } catch {
      fresh = null;
    }
    if (turn !== this.turn || !this.descriptor) return;
    // A different avatar (picked on the hub since) is not swapped in here; the
    // body this visitor sees and the one others see stay the same.
    if (!fresh || !sameAvatar(fresh, this.descriptor)) return;
    this.descriptor = fresh;
    this.shared = shareableAvatar(fresh);
    this.schedule();
  }
}

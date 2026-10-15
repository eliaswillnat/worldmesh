import { parseAvatarShare, type AvatarDescriptor, type SignedAvatarShare } from './descriptor.js';

/**
 * Which avatar other players may see, keeping its link fresh, and checking the
 * links other players send.
 *
 * Other players download a model straight from the platform, so a link must
 * never be one a player made up: a server of their own would learn the IP
 * address of everyone in the room. So only links the WorldMesh hub signed
 * (Ed25519) when it resolved the avatar are sent, and a link from someone
 * else is downloaded only if its signature checks out against the hub's
 * public key. The hub signs Sketchfab links and at3d links on Bluesky's hosts;
 * never VRoid Hub (its license needs "Multiplay" approval for other players)
 * or a self-hosted AT Protocol server.
 *
 * Links and signatures expire (Sketchfab's links within minutes), so the owner
 * asks for a fresh one before the old runs out; someone joining later still
 * gets a working link. Players who already loaded the model keep it.
 */

/** Never shown to other players, even if a hub signed it. */
const PRIVATE_PROVIDERS: readonly string[] = ['vroid'];
/** Ask for a new link this long before the old one expires. */
const REFRESH_EARLY_MS = 45_000;
const MIN_REFRESH_MS = 30_000;
const SHARE_CONTEXT = 'worldmesh-avatar-share-v1';

/** The hub-signed link other players may be shown, or null when there is none. */
export function shareableAvatar(descriptor: AvatarDescriptor | null): SignedAvatarShare | null {
  if (!descriptor || PRIVATE_PROVIDERS.includes(descriptor.provider)) return null;
  return parseAvatarShare(descriptor.share);
}

/** Same avatar, possibly a different link. */
function sameAvatar(a: AvatarDescriptor, b: AvatarDescriptor): boolean {
  if (a.avatarId || b.avatarId) return a.provider === b.provider && a.avatarId === b.avatarId;
  return a.modelUrl === b.modelUrl;
}

/**
 * The avatar this visitor shows other players. Set it whenever the local
 * avatar changes; with `resolve` (asks the hub again), it keeps the signed
 * link current, and fetches one if the descriptor came without.
 */
export class SharedAvatarLink {
  private descriptor: AvatarDescriptor | null = null;
  private shared: SignedAvatarShare | null = null;
  private timer = 0;
  private turn = 0;

  constructor(private resolve: (() => Promise<AvatarDescriptor | null>) | null) {}

  set(descriptor: AvatarDescriptor | null): void {
    this.turn += 1;
    window.clearTimeout(this.timer);
    this.descriptor = descriptor;
    this.shared = shareableAvatar(descriptor);
    // Handed over without a signed link (e.g. by an older hub): ask for one now.
    if (descriptor && !this.shared && !PRIVATE_PROVIDERS.includes(descriptor.provider) && descriptor.share === undefined && this.resolve) {
      const turn = this.turn;
      this.timer = window.setTimeout(() => void this.refresh(turn), 0);
      return;
    }
    this.schedule();
  }

  get(): SignedAvatarShare | null {
    return this.shared;
  }

  dispose(): void {
    this.turn += 1;
    window.clearTimeout(this.timer);
    this.resolve = null;
  }

  private schedule(): void {
    const descriptor = this.descriptor;
    const shared = this.shared;
    if (!this.resolve || !shared || !descriptor) return;
    const linkExpires = descriptor.expiresAt ? Date.parse(descriptor.expiresAt) : Infinity;
    const expires = Math.min(shared.x * 1000, Number.isFinite(linkExpires) ? linkExpires : Infinity);
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

/** The exact bytes the hub signs (workers/auth/src/avatars/share.ts). */
function sharePayload(share: SignedAvatarShare): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${SHARE_CONTEXT}\n${share.u}\n${share.f}\n${share.i}\n${share.x}`);
}

const verifiers = new Map<string, (share: SignedAvatarShare) => Promise<boolean>>();

/**
 * Checks links other players send against the public key of the hub at
 * `hubUrl` (fetched once from its resolve endpoint). Says no when the key
 * cannot be had or the browser cannot check Ed25519, so nothing unchecked is
 * ever downloaded.
 */
export function createShareVerifier(hubUrl: string): (share: SignedAvatarShare) => Promise<boolean> {
  let endpoint: string;
  try {
    endpoint = new URL('/api/account/avatar/resolve', hubUrl).toString();
  } catch {
    return async () => false;
  }
  const existing = verifiers.get(endpoint);
  if (existing) return existing;

  let key: Promise<CryptoKey | null> | null = null;
  let failedAt = 0;
  const loadKey = (): Promise<CryptoKey | null> => {
    // After a failure, try again a minute later rather than on every link.
    if (key && !(failedAt && Date.now() - failedAt > 60_000)) return key;
    failedAt = 0;
    key = (async () => {
      try {
        const response = await fetch(endpoint, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`Key request failed (${response.status})`);
        const body = (await response.json()) as { key?: { kty?: unknown; crv?: unknown; x?: unknown } | null };
        const jwk = body.key;
        if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('The hub has no share key');
        return await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
      } catch (error) {
        failedAt = Date.now();
        console.warn('[worldmesh] Cannot check other players’ avatar links; showing default bodies.', error);
        return null;
      }
    })();
    return key;
  };

  const verify = async (share: SignedAvatarShare): Promise<boolean> => {
    const publicKey = await loadKey();
    if (!publicKey) return false;
    try {
      return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromBase64url(share.s), sharePayload(share));
    } catch {
      return false;
    }
  };
  verifiers.set(endpoint, verify);
  return verify;
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

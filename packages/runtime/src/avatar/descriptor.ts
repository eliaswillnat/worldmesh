/**
 * The only thing the runtime knows about external avatars: a normalized
 * descriptor pointing at a model file the avatar's platform hosts. How it was
 * found (which platform, which account, which OAuth flow) stays with whoever
 * produced it — the WorldMesh hub's Avatar Wallet, or the world itself.
 */

export type AvatarFormat = 'vrm' | 'glb' | 'gltf';

export interface AvatarDescriptor {
  /** Where the avatar lives, e.g. 'vroid' or 'atproto'. Informational. */
  provider: string;
  /** The platform's id for the avatar. Informational. */
  avatarId: string;
  name: string | null;
  thumbnail: string | null;
  format: AvatarFormat;
  /** The model file, on the platform's own storage. May be short-lived. */
  modelUrl: string;
  /** When `modelUrl` stops working (ISO 8601), or null. */
  expiresAt: string | null;
  /** The avatar's public page, for credit where its license asks for it. */
  sourceUrl: string | null;
  /**
   * The model link signed by the WorldMesh hub for showing to other players,
   * or null when it may not be shown to them (see avatar/share.ts).
   */
  share?: SignedAvatarShare | null;
}

/** A model link the hub vouched for: `u` link, `f` format, `i` stable id, `x` expiry (unix seconds), `s` Ed25519 signature. */
export interface SignedAvatarShare {
  u: string;
  f: AvatarFormat;
  i: string;
  x: number;
  s: string;
}

/** Accepts a signed share from the network only if it has the right shape. Says nothing about the signature. */
export function parseAvatarShare(value: unknown): SignedAvatarShare | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.u !== 'string' || !v.u.startsWith('https:') || v.u.length > 1800 || !isLoadableUrl(v.u)) return null;
  if (typeof v.f !== 'string' || !FORMATS.includes(v.f)) return null;
  if (typeof v.i !== 'string' || !/^[a-z0-9]{1,16}$/.test(v.i)) return null;
  if (typeof v.x !== 'number' || !Number.isInteger(v.x) || v.x <= 0 || v.x > 1e11) return null;
  if (typeof v.s !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(v.s)) return null;
  return { u: v.u, f: v.f as AvatarFormat, i: v.i, x: v.x, s: v.s };
}

const FORMATS: readonly string[] = ['vrm', 'glb', 'gltf'];

/** Model URLs must be https, except on a local development machine. */
export function isLoadableUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Accepts a descriptor from the network only if it has the right shape. */
export function parseAvatarDescriptor(value: unknown): AvatarDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (typeof d.format !== 'string' || !FORMATS.includes(d.format) || !isLoadableUrl(d.modelUrl)) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    provider: text(d.provider) ?? 'unknown',
    avatarId: text(d.avatarId) ?? '',
    name: text(d.name),
    thumbnail: isLoadableUrl(d.thumbnail) ? d.thumbnail : null,
    format: d.format as AvatarFormat,
    modelUrl: d.modelUrl,
    expiresAt: text(d.expiresAt),
    sourceUrl: isLoadableUrl(d.sourceUrl) ? d.sourceUrl : null,
    // Absent (an older hub) is not the same as null (the hub says: do not show to others).
    share: 'share' in d ? parseAvatarShare(d.share) : undefined,
  };
}

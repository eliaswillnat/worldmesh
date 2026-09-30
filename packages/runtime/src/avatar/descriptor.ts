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
  };
}

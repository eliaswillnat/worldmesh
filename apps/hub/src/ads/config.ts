/**
 * Billboard advertising: every tunable in one place. Imported by the hub (the
 * modal and the 3D billboards) and by workers/ads (validation, Stripe, sweeps),
 * so the browser and the server can never disagree about a limit.
 *
 * Pure data and pure functions only: no DOM, no three, no Workers APIs.
 */

const MB = 1024 * 1024;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export type AdMediaType = 'image' | 'video';

export const AD_CONFIG = {
  /**
   * Hub walk-mode ads UI and live-ad rendering. Off by default so visitors do
   * not see bookable billboards until the ads Worker is deployed and this is
   * flipped on. The hub also honours `VITE_ADS_ENABLED=true|false` at build
   * time (see docs/advertising.md). The Worker ignores this flag.
   */
  enabled: false,
  /** What one advertisement costs, in the smallest currency unit. */
  priceCents: 200,
  currency: 'eur',
  priceLabel: '€2',
  /** How long an approved advertisement stays up, counted from approval. */
  durationMs: 30 * DAY,
  /**
   * How long a billboard stays reserved for someone who has uploaded but not
   * yet authorized payment. Closing the payment window releases it sooner.
   */
  reservationMs: 15 * MINUTE,
  /**
   * Card authorizations lapse after about 7 days. Stripe tells us the exact
   * moment per charge (capture_before); this is the fallback when it does not.
   */
  authorizationFallbackMs: 7 * DAY,
  /** Give up on an uncaptured authorization this long before it lapses. */
  authorizationSafetyMs: 2 * 60 * MINUTE,
  /** Media of rejected, expired and abandoned submissions is deleted after this long. */
  mediaRetentionMs: 30 * DAY,
  /** Abandoned before payment: nobody needs the upload, delete it soon. */
  abandonedMediaRetentionMs: 1 * DAY,
  /** Unpaid holds one address may have open at once. */
  maxOpenHoldsPerClient: 2,

  image: {
    types: { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'] } as Record<string, string[]>,
    maxBytes: 5 * MB,
    /** Longest side in pixels. Bigger images cost mobile GPUs a lot of memory for nothing. */
    maxDimension: 4096,
  },
  video: {
    types: { 'video/mp4': ['mp4'], 'video/webm': ['webm'] } as Record<string, string[]>,
    maxBytes: 25 * MB,
    maxSeconds: 60,
    maxDimension: 1920,
  },
  /** The still frame shown for a video ad while it is far away, and in the moderation email. */
  poster: {
    type: 'image/jpeg',
    maxBytes: 600 * 1024,
    maxDimension: 1280,
  },
  text: {
    advertiserMaxLength: 80,
    emailMaxLength: 254,
    urlMaxLength: 2048,
    rejectReasonMaxLength: 500,
  },
} as const;

export type AdStatus =
  /** Uploaded; billboard held briefly while the advertiser authorizes payment. */
  | 'awaiting_payment'
  /** €2 authorized (not captured); waiting for manual review. */
  | 'pending'
  /** Approved by the admin; capture in progress. */
  | 'approved'
  /** Captured and on the billboard. */
  | 'active'
  | 'rejected'
  /** The authorization lapsed before review, or the advertisement's run ended. */
  | 'expired'
  /** Abandoned before payment was authorized. */
  | 'cancelled'
  /** Payment could not be captured. */
  | 'failed';

/** Statuses that occupy a billboard. Mirrored by the partial unique index in db/migrations/0005_ads.sql. */
export const LIVE_STATUSES: readonly AdStatus[] = ['awaiting_payment', 'pending', 'approved', 'active'];

export function mediaTypeOf(mime: string): AdMediaType | null {
  if (mime in AD_CONFIG.image.types) return 'image';
  if (mime in AD_CONFIG.video.types) return 'video';
  return null;
}

export function limitsFor(type: AdMediaType) {
  return type === 'image' ? AD_CONFIG.image : AD_CONFIG.video;
}

/** The MIME type a file name's extension implies within `type`, or null. */
export function mimeForExtension(type: AdMediaType, filename: string): string | null {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext) return null;
  for (const [mime, exts] of Object.entries(limitsFor(type).types)) if (exts.includes(ext)) return mime;
  return null;
}

/**
 * Destination URLs: https only, a real host, no credentials, bounded length.
 * Returns the normalised URL, or null. Rules out javascript:, data:, file:,
 * http: and anything else that is not plain https.
 */
export function normalizeDestinationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > AD_CONFIG.text.urlMaxLength) return null;
  // Control characters and whitespace inside a URL are how scheme filters get dodged.
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  // A public hostname with a dot, not localhost or a bare IP literal.
  if (!host.includes('.') || host.endsWith('.') || /^\[|^\d+(\.\d+){3}$/.test(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  const href = url.toString();
  return href.length <= AD_CONFIG.text.urlMaxLength ? href : null;
}

/**
 * Advertiser names: printable text, no markup-significant characters, single
 * spaces, bounded length. Returns the cleaned value, or null if nothing usable is left.
 */
export function sanitizeAdvertiserName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFC')
    // Control, format (bidi overrides, zero-width) and markup characters.
    .replace(/[\p{Cc}\p{Cf}<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > AD_CONFIG.text.advertiserMaxLength) return null;
  return cleaned;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > AD_CONFIG.text.emailMaxLength) return null;
  // Deliberately plain: one @, a dotted domain, no spaces, quotes or markup.
  if (!/^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) {
    return null;
  }
  return email;
}

export function formatBytes(bytes: number): string {
  return bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function durationLabel(): string {
  return `${Math.round(AD_CONFIG.durationMs / DAY)} days`;
}

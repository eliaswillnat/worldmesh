export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  ADS_MEDIA: R2Bucket;
  /** The hub's public origin, e.g. https://worldmesh.net. */
  ADS_ORIGIN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY: string;
  /** Signs media links in emails and the admin forms' CSRF tokens. */
  ADS_SIGNING_SECRET: string;
  RESEND_API_KEY?: string;
  /** The admin inbox that receives moderation emails. */
  NOTIFICATION_EMAIL?: string;
  FROM_EMAIL?: string;
  /** Comma-separated verified account emails allowed to moderate. */
  ADMIN_EMAILS?: string;
  ADS_LIMITER?: RateLimiter;
  /** Tests only: a fixed clock. */
  NOW?: () => number;
}

export function origin(env: Env): string {
  return env.ADS_ORIGIN.replace(/\/+$/, '');
}

export function now(env: Env): number {
  return env.NOW ? env.NOW() : Date.now();
}

export function adminInbox(env: Env): string {
  return env.NOTIFICATION_EMAIL || 'elias.willnat@gmail.com';
}

export function adminEmails(env: Env): Set<string> {
  const list = (env.ADMIN_EMAILS || adminInbox(env))
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

/** Secrets that must be present before anything touches money. */
export function assertConfigured(env: Env): void {
  const missing = (['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'ADS_SIGNING_SECRET'] as const).filter((name) => !env[name]);
  if (missing.length) throw new Error(`workers/ads is missing: ${missing.join(', ')}`);
  if (env.ADS_SIGNING_SECRET.length < 32) throw new Error('ADS_SIGNING_SECRET must be at least 32 characters.');
}

/**
 * Who may use this worker. Every capture starts a headless browser on our
 * Cloudflare bill, so nothing runs for strangers.
 *
 * - server: WorldMesh's own backends (the hub's admin functions, the admin
 *   worker). They send `Authorization: Bearer <SCREENSHOT_SECRET>` and may do
 *   everything.
 * - browser: the hub page itself, recognised by its Origin. A secret in the
 *   page would be public, so browsers get only what the submit form needs:
 *   one screenshot of the submitted world, under a rate limit. Scripts can
 *   fake an Origin, which is why that limit exists.
 */

export type Caller = 'server' | 'browser' | null;

export interface AccessEnv {
  SCREENSHOT_SECRET?: string;
  /** Comma-separated origins allowed to call from a browser. */
  ALLOWED_ORIGINS?: string;
  /** Browser-requested screenshots allowed per hour, across everyone. */
  BROWSER_SCREENSHOTS_PER_HOUR?: string;
  SCREENSHOTS: R2Bucket;
}

const DEFAULT_ORIGINS = 'https://worldmesh.net,https://www.worldmesh.net';
const DEFAULT_SCREENSHOTS_PER_HOUR = 20;
/** The same world can only be screenshotted from a browser once in this window. */
const PER_WORLD_WINDOW = 10 * 60 * 1000;
/** A screenshot request is a URL. */
export const MAX_BROWSER_BODY = 16 * 1024;

export function allowedOrigin(request: Request, env: AccessEnv): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

export async function identify(request: Request, env: AccessEnv): Promise<Caller> {
  const auth = request.headers.get('Authorization');
  if (auth && env.SCREENSHOT_SECRET && (await sameSecret(auth, `Bearer ${env.SCREENSHOT_SECRET}`))) return 'server';
  return allowedOrigin(request, env) ? 'browser' : null;
}

/**
 * Rate limit for browser screenshots: one per world per window, and a cap per
 * hour overall. Counters live in R2, so two requests racing can both get
 * through; the limit bounds cost, it is not exact.
 */
export async function takeBrowserScreenshotSlot(env: AccessEnv, target: URL): Promise<string | null> {
  const now = Date.now();
  const worldKey = `limits/screenshot-world/${target.hostname}`;
  const last = await env.SCREENSHOTS.head(worldKey);
  if (last && now - last.uploaded.getTime() < PER_WORLD_WINDOW) {
    return 'This world was screenshotted a few minutes ago.';
  }

  const perHour = Number(env.BROWSER_SCREENSHOTS_PER_HOUR) || DEFAULT_SCREENSHOTS_PER_HOUR;
  const hourKey = `limits/browser-screenshots/${new Date(now).toISOString().slice(0, 13)}`;
  const counter = await env.SCREENSHOTS.get(hourKey);
  const count = counter ? Number(await counter.text()) || 0 : 0;
  if (count >= perHour) return 'Too many screenshots this hour. Try again later.';

  await Promise.all([env.SCREENSHOTS.put(hourKey, String(count + 1)), env.SCREENSHOTS.put(worldKey, String(now))]);
  return null;
}

/** Constant-time comparison, so response timing does not leak the secret. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

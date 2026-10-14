/**
 * Who may use this worker: cover uploads go into our R2 bucket, so nothing
 * runs for strangers.
 *
 * - server: WorldMesh's own backends (the admin worker). They send
 *   `Authorization: Bearer <SCREENSHOT_SECRET>` and are the only ones who
 *   may POST.
 * - The hub page itself, recognised by its Origin, may read responses.
 */

export type Caller = 'server' | null;

export interface AccessEnv {
  SCREENSHOT_SECRET?: string;
  /** Comma-separated origins allowed to read from a browser. */
  ALLOWED_ORIGINS?: string;
  SCREENSHOTS: R2Bucket;
}

const DEFAULT_ORIGINS = 'https://worldmesh.net,https://www.worldmesh.net';
/** Largest cover upload, as JSON with the image in base64. */
export const MAX_UPLOAD_BODY = 16 * 1024 * 1024;

export function allowedOrigin(request: Request, env: AccessEnv): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

export async function identify(request: Request, env: AccessEnv): Promise<Caller> {
  const auth = request.headers.get('Authorization');
  return auth && env.SCREENSHOT_SECRET && (await sameSecret(auth, `Bearer ${env.SCREENSHOT_SECRET}`)) ? 'server' : null;
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

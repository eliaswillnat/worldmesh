import { origin, type Env } from './env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function json(data: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
  });
}

export function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

/**
 * Admin pages: never cached, never framed, no scripts at all, and no Referer
 * leaking the review URL when the admin follows an advertiser's link.
 */
export function adminHtml(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, Location: location, 'Cache-Control': 'no-store' } });
}

/**
 * CSRF guard for state-changing browser requests: the browser must say the
 * request comes from the hub's own origin.
 */
export function isSameOrigin(request: Request, env: Env): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  return request.headers.get('Origin') === origin(env);
}

/** Reads a small JSON body, refusing anything oversized or not JSON. */
export async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Expected application/json.');
  const text = await readText(request, maxBytes);
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'Request too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Request too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

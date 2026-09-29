export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** An ActivityStreams document. `maxAge` makes it publicly cacheable. */
export function activityJson(data: unknown, maxAge = 0, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/activity+json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      Vary: 'Accept',
    },
  });
}

export function jsonResponse(data: unknown, status = 200, contentType = 'application/json', maxAge = 0): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': `${contentType}; charset=utf-8`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

export function htmlResponse(html: string, status = 200, maxAge = 0): Response {
  return new Response(html, {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
      Vary: 'Accept',
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

/** Does the client ask for ActivityStreams rather than a web page? */
export function wantsActivityJson(request: Request): boolean {
  const accept = (request.headers.get('Accept') ?? '').toLowerCase();
  return accept.includes('application/activity+json') || accept.includes('application/ld+json');
}

export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'Payload too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Payload too large.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Serves public GETs from Cloudflare's edge cache when possible, so repeated
 * WebFinger/actor/object fetches from the fediverse cost no D1 reads. The
 * cache key includes whether ActivityStreams or HTML was asked for.
 */
export async function cached(
  request: Request,
  ctx: ExecutionContext,
  produce: () => Promise<Response>,
): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache || request.method !== 'GET') return produce();
  const key = new URL(request.url);
  key.searchParams.set('__variant', wantsActivityJson(request) ? 'as' : 'html');
  const cacheKey = new Request(key.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const response = await produce();
  if (response.status === 200 && /public/.test(response.headers.get('Cache-Control') ?? '')) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

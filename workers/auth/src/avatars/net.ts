/**
 * Outgoing requests to avatar providers. AT Protocol hosts (a handle's
 * domain, did:web hosts, PDSes, authorization servers) come from user input
 * or from documents other people control, so every hop — including each
 * redirect — must be a plain public https URL on a real domain name, and
 * every response is time- and size-capped.
 */

export class UnsafeUrlError extends Error {}

/** TLDs that only resolve on private networks, or are reserved for testing. */
const PRIVATE_TLDS = new Set([
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp',
  'private', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt',
]);

export function assertPublicUrl(raw: string, ownHost: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new UnsafeUrlError('URL too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a URL');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('Only https is allowed');
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URL');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('Non-standard port');
  // The URL parser canonicalises every IPv4 notation to dotted quads and IPv6 to [brackets].
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (host.startsWith('[') || /^[0-9]+$/.test(tld)) throw new UnsafeUrlError('IP addresses are not allowed');
  if (labels.length < 2 || labels.some((label) => !label)) throw new UnsafeUrlError('Not a public hostname');
  if (PRIVATE_TLDS.has(tld)) throw new UnsafeUrlError('Not a public hostname');
  if (host === ownHost.toLowerCase().split(':')[0]) throw new UnsafeUrlError('Refusing to fetch ourselves');
  return url;
}

export interface FetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  /** The hub's own host, which is never fetched. */
  ownHost: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** 'manual' returns a redirect as-is (VRoid's download endpoint answers with one). */
  redirect?: 'follow' | 'manual';
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export async function providerFetch(raw: string, options: FetchOptions): Promise<FetchResult> {
  const { ownHost, maxBytes = 256 * 1024, timeoutMs = 8000, redirect = 'follow', ...init } = options;
  let url = assertPublicUrl(raw, ownHost);
  for (let hop = 0; ; hop++) {
    const response = await fetch(url.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = response.headers.get('Location');
    if (redirect === 'follow' && response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= 3) throw new UnsafeUrlError('Too many redirects');
      url = assertPublicUrl(new URL(location, url).toString(), ownHost);
      continue;
    }
    return { url: url.toString(), status: response.status, headers: response.headers, body: await readCapped(response, maxBytes) };
  }
}

/** The response body as a JSON object, or null. */
export function jsonObject(result: FetchResult): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(result.body)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A stored avatar's metadata_json, or an empty object. */
export function parseMetadata(json: string | null): Record<string, unknown> {
  try {
    const value = (json ? JSON.parse(json) : {}) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Walks into nested JSON objects, or returns undefined. */
export function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length') ?? '0') > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

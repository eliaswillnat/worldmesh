/**
 * The only way this Worker talks to the fediverse. Every remote URL — keyIds,
 * actor documents, inboxes — is attacker-supplied, so each hop (including
 * every redirect) must be a plain public https URL on a real domain name, and
 * every response is size- and time-capped.
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

  // The URL parser already canonicalises every IPv4 notation (decimal, octal,
  // hex, short forms) to dotted quads, and IPv6 to [brackets].
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (host.startsWith('[') || /^[0-9]+$/.test(tld)) throw new UnsafeUrlError('IP addresses are not allowed');
  if (labels.length < 2 || labels.some((label) => !label)) throw new UnsafeUrlError('Not a public hostname');
  if (PRIVATE_TLDS.has(tld)) throw new UnsafeUrlError('Not a public hostname');
  if (host === ownHost.toLowerCase().split(':')[0]) throw new UnsafeUrlError('Refusing to fetch ourselves');
  return url;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface SafeFetchOptions {
  ownHost: string;
  /** Called per hop, so signed GETs are re-signed for each redirect target. */
  init: (url: URL) => Promise<RequestInit> | RequestInit;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const { ownHost, maxBytes = 512 * 1024, timeoutMs = 8000, maxRedirects = 3 } = options;
  let url = assertPublicUrl(raw, ownHost);
  for (let hop = 0; ; hop++) {
    const init = await options.init(url);
    const response = await fetch(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = response.headers.get('Location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= maxRedirects) throw new UnsafeUrlError('Too many redirects');
      url = assertPublicUrl(new URL(location, url).toString(), ownHost);
      continue;
    }
    return { url: url.toString(), status: response.status, headers: response.headers, body: await readCapped(response, maxBytes) };
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) {
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

export const ACTIVITY_JSON = 'application/activity+json';
export const ACCEPT_ACTIVITY = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export function isActivityJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return (
    type.startsWith('application/activity+json') ||
    (type.startsWith('application/ld+json') && type.includes('https://www.w3.org/ns/activitystreams'))
  );
}

/** Parses JSON with a nesting-depth cap, so a hostile document cannot blow the stack later. */
export function parseJsonObject(bytes: Uint8Array, maxDepth = 16): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return depthOk(value, maxDepth) ? (value as Record<string, unknown>) : null;
}

function depthOk(value: unknown, remaining: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (remaining <= 0) return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.every((child) => depthOk(child, remaining - 1));
}

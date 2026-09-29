/**
 * HTTP Signatures as used across the fediverse today: draft-cavage-http-signatures-12
 * with rsa-sha256 (a.k.a. hs2019 over an RSA key), plus the Digest header for
 * bodies. This is what Mastodon sends and requires on every server-to-server
 * POST. RFC 9421 (HTTP Message Signatures) is not implemented yet; Mastodon
 * only uses it as a fallback after a cavage signature is refused.
 */
import { fromBase64, sha256Base64, sign, toBase64, verify } from './keys';

/** Mastodon accepts signatures up to 12 hours old; so do we. */
export const MAX_SIGNATURE_AGE_MS = 12 * 60 * 60 * 1000;
/** Clock skew tolerated for signatures from the future. */
export const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

export async function digestHeader(body: Uint8Array | string): Promise<string> {
  return `SHA-256=${await sha256Base64(body)}`;
}

export interface SignOptions {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
  keyId: string;
  privateKey: CryptoKey;
  now?: Date;
}

/** Adds Host, Date, (Digest) and Signature headers to `headers`, as Mastodon expects. */
export async function signRequest(options: SignOptions): Promise<Headers> {
  const { method, headers, body, keyId, privateKey } = options;
  const url = new URL(options.url);
  headers.set('Host', url.host);
  headers.set('Date', (options.now ?? new Date()).toUTCString());
  const signed = ['(request-target)', 'host', 'date'];
  if (body !== undefined) {
    headers.set('Digest', await digestHeader(body));
    signed.push('digest');
    if (headers.has('Content-Type')) signed.push('content-type');
  } else if (headers.has('Accept')) {
    signed.push('accept');
  }
  const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = signed
    .map((name) => (name === '(request-target)' ? `${name}: ${target}` : `${name}: ${headers.get(name)}`))
    .join('\n');
  const signature = toBase64(new Uint8Array(await sign(privateKey, signingString)));
  headers.set(
    'Signature',
    `keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.join(' ')}",signature="${signature}"`,
  );
  return headers;
}

export interface ParsedSignature {
  keyId: string;
  algorithm?: string;
  headers: string[];
  signature: Uint8Array;
  created?: number;
  expires?: number;
}

export function parseSignatureHeader(value: string | null): ParsedSignature | null {
  if (!value || value.length > 8192) return null;
  const params = new Map<string, string>();
  const pattern = /\s*([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([0-9]+))\s*(?:,|$)/y;
  let match: RegExpExecArray | null;
  let end = 0;
  while ((match = pattern.exec(value))) {
    const key = match[1].toLowerCase();
    if (params.has(key)) return null;
    params.set(key, match[2] ?? match[3]);
    end = pattern.lastIndex;
    if (end >= value.length) break;
  }
  if (end !== value.length) return null;

  const keyId = params.get('keyid');
  const signature = params.get('signature');
  if (!keyId || !signature) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(signature);
  } catch {
    return null;
  }
  const created = params.has('created') ? Number(params.get('created')) : undefined;
  const expires = params.has('expires') ? Number(params.get('expires')) : undefined;
  return {
    keyId,
    algorithm: params.get('algorithm')?.toLowerCase(),
    // The spec default is "date" alone, which we then refuse as too weak.
    headers: (params.get('headers') ?? 'date').toLowerCase().trim().split(/\s+/),
    signature: bytes,
    created: Number.isFinite(created) ? created : undefined,
    expires: Number.isFinite(expires) ? expires : undefined,
  };
}

export type VerifyFailure =
  | 'missing-signature'
  | 'unsupported-algorithm'
  | 'insufficient-headers'
  | 'stale'
  | 'digest-mismatch'
  | 'bad-host'
  | 'unknown-key'
  | 'bad-signature';

export type VerifyResult = { ok: true; keyId: string; owner: string } | { ok: false; reason: VerifyFailure };

/** Looks up the public key for a keyId; `refresh` asks to bypass any cache (key rotation). */
export type KeyResolver = (
  keyId: string,
  refresh: boolean,
) => Promise<{ key: CryptoKey; owner: string; fresh: boolean } | null>;

/**
 * Verifies an incoming request's cavage signature against its raw body.
 * `expectedHost` is our own host: a signature made for another host is refused.
 */
export async function verifyRequest(
  request: Request,
  body: Uint8Array,
  expectedHost: string,
  resolveKey: KeyResolver,
  now = Date.now(),
): Promise<VerifyResult> {
  const parsed = parseSignatureHeader(request.headers.get('Signature'));
  if (!parsed) return { ok: false, reason: 'missing-signature' };
  if (parsed.algorithm && !['rsa-sha256', 'hs2019'].includes(parsed.algorithm)) {
    return { ok: false, reason: 'unsupported-algorithm' };
  }

  const covered = new Set(parsed.headers);
  const hasTime = covered.has('date') || covered.has('(created)');
  const hasBodyDigest = covered.has('digest') || covered.has('content-digest');
  if (!covered.has('(request-target)') || !covered.has('host') || !hasTime) {
    return { ok: false, reason: 'insufficient-headers' };
  }
  if (request.method === 'POST' && !hasBodyDigest) return { ok: false, reason: 'insufficient-headers' };

  if ((request.headers.get('Host') ?? new URL(request.url).host).toLowerCase() !== expectedHost.toLowerCase()) {
    return { ok: false, reason: 'bad-host' };
  }

  // Freshness: both the Date header and (created)/(expires) when signed.
  const times: number[] = [];
  if (covered.has('date')) {
    const date = Date.parse(request.headers.get('Date') ?? '');
    if (Number.isNaN(date)) return { ok: false, reason: 'stale' };
    times.push(date);
  }
  if (covered.has('(created)')) {
    if (parsed.created === undefined) return { ok: false, reason: 'stale' };
    times.push(parsed.created * 1000);
  }
  if (times.some((t) => now - t > MAX_SIGNATURE_AGE_MS || t - now > MAX_CLOCK_SKEW_MS)) {
    return { ok: false, reason: 'stale' };
  }
  if (covered.has('(expires)') && (parsed.expires === undefined || parsed.expires * 1000 < now)) {
    return { ok: false, reason: 'stale' };
  }

  if (hasBodyDigest && !(await bodyMatchesDigest(request.headers, body, covered))) {
    return { ok: false, reason: 'digest-mismatch' };
  }

  const signingString = buildSigningString(request, parsed);
  if (signingString === null) return { ok: false, reason: 'insufficient-headers' };

  for (const refresh of [false, true]) {
    const resolved = await resolveKey(parsed.keyId, refresh);
    if (!resolved) return { ok: false, reason: 'unknown-key' };
    if (await verify(resolved.key, parsed.signature, signingString)) {
      return { ok: true, keyId: parsed.keyId, owner: resolved.owner };
    }
    // A cached key may have been rotated: refetch once, but only if it was cached.
    if (resolved.fresh) break;
  }
  return { ok: false, reason: 'bad-signature' };
}

function buildSigningString(request: Request, parsed: ParsedSignature): string | null {
  const url = new URL(request.url);
  const lines: string[] = [];
  for (const name of parsed.headers) {
    if (name === '(request-target)') {
      lines.push(`${name}: ${request.method.toLowerCase()} ${url.pathname}${url.search}`);
    } else if (name === '(created)') {
      lines.push(`${name}: ${parsed.created}`);
    } else if (name === '(expires)') {
      if (parsed.expires === undefined) return null;
      lines.push(`${name}: ${parsed.expires}`);
    } else if (name === 'host') {
      lines.push(`host: ${request.headers.get('Host') ?? url.host}`);
    } else {
      const value = request.headers.get(name);
      if (value === null) return null;
      lines.push(`${name}: ${value}`);
    }
  }
  return lines.join('\n');
}

async function bodyMatchesDigest(headers: Headers, body: Uint8Array, covered: Set<string>): Promise<boolean> {
  const expected = await sha256Base64(body);
  if (covered.has('digest')) {
    // Digest: SHA-256=<base64>[, other=...]
    const values = (headers.get('Digest') ?? '').split(',').map((part) => part.trim());
    const sha = values.find((part) => /^sha-256=/i.test(part));
    if (!sha || sha.slice(8) !== expected) return false;
  }
  if (covered.has('content-digest')) {
    // RFC 9530 Content-Digest: sha-256=:<base64>:
    const match = (headers.get('Content-Digest') ?? '').match(/(?:^|,)\s*sha-256=:([A-Za-z0-9+/=]+):/i);
    if (!match || match[1] !== expected) return false;
  }
  return true;
}

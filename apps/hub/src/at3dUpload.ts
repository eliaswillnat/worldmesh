/**
 * Uploads a VRM or GLB straight from the browser to the user's own AT Protocol
 * server (PDS) as an at3d avatar. WorldMesh only hands over a short-lived,
 * upload-only grant (see workers/auth/src/avatars/atproto.ts); the file itself
 * never passes through WorldMesh.
 *
 * The grant's access token is DPoP-bound, so each request carries a proof
 * signed with the grant's key (https://atproto.com/specs/oauth).
 */

export interface UploadGrant {
  provider: string;
  /** The user's PDS. */
  service: string;
  /** The user's DID. */
  account: string;
  accessToken: string;
  dpopKey: JsonWebKey;
  expiresAt: number;
}

/** Larger models are refused by worlds anyway (the runtime's default maxBytes). */
export const MAX_MODEL_BYTES = 40 * 1024 * 1024;
const MODEL_MIME = 'model/gltf-binary';
const COLLECTION = 'app.at3d.avatar';

export interface ModelInfo {
  format: 'vrm' | 'gltf';
  /** For VRM models: '0.x' or '1.0'. */
  vrmVersion: string | null;
}

/** Reads the GLB header and JSON chunk: is this a GLB, and is it a VRM? */
export async function inspectModel(file: File): Promise<ModelInfo> {
  const head = new DataView(await file.slice(0, 20).arrayBuffer());
  // "glTF", version 2, then the first chunk (JSON) length and type.
  if (head.byteLength < 20 || head.getUint32(0, true) !== 0x46546c67 || head.getUint32(4, true) !== 2) {
    throw new Error('That file is not a VRM or GLB model.');
  }
  const jsonLength = head.getUint32(12, true);
  if (head.getUint32(16, true) !== 0x4e4f534a || jsonLength > 32 * 1024 * 1024) {
    throw new Error('That file is not a VRM or GLB model.');
  }
  let json: { extensionsUsed?: unknown; extensions?: Record<string, unknown> };
  try {
    json = JSON.parse(await file.slice(20, 20 + jsonLength).text());
  } catch {
    throw new Error('That model file is damaged.');
  }
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  const has = (name: string) => used.includes(name) || !!json.extensions?.[name];
  if (has('VRMC_vrm')) return { format: 'vrm', vrmVersion: '1.0' };
  if (has('VRM')) return { format: 'vrm', vrmVersion: '0.x' };
  return { format: 'gltf', vrmVersion: null };
}

/** Uploads the model and creates its at3d record. Returns the record's at:// URI. */
export async function uploadToAt3d(grant: UploadGrant, file: File, name: string, info: ModelInfo): Promise<string> {
  const client = await dpopClient(grant);

  const blobResponse = await client.fetch(xrpc(grant, 'com.atproto.repo.uploadBlob'), {
    method: 'POST',
    headers: { 'Content-Type': MODEL_MIME },
    body: file,
  });
  const uploaded = (await readJson(blobResponse, 'Your AT Protocol server did not accept the model.')) as { blob?: unknown };
  if (!uploaded.blob) throw new Error('Your AT Protocol server did not accept the model.');

  const now = new Date().toISOString();
  const record = {
    $type: COLLECTION,
    name,
    format: info.format,
    appearance:
      info.format === 'vrm'
        ? { $type: `${COLLECTION}#vrmAppearance`, model: uploaded.blob, vrmVersion: info.vrmVersion }
        : { $type: `${COLLECTION}#gltfAppearance`, model: uploaded.blob },
    createdAt: now,
    updatedAt: now,
  };
  const created = await client.fetch(xrpc(grant, 'com.atproto.repo.createRecord'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: grant.account, collection: COLLECTION, record }),
  });
  const { uri } = (await readJson(created, 'Your AT Protocol server did not save the avatar.')) as { uri?: unknown };
  if (typeof uri !== 'string') throw new Error('Your AT Protocol server did not save the avatar.');
  return uri;
}

function xrpc(grant: UploadGrant, method: string): string {
  return new URL(`/xrpc/${method}`, grant.service).toString();
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  const data = (await response.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  if (response.ok) return data;
  if (response.status === 413 || data.error === 'BlobTooLarge') throw new Error('The model is too large for your AT Protocol server.');
  if (response.status === 401 || response.status === 403) throw new Error('The upload permission was refused or has expired. Start the upload again.');
  throw new Error(typeof data.message === 'string' && data.message ? `${fallback} (${data.message})` : fallback);
}

// ── DPoP ─────────────────────────────────────────────────────────────────────

async function dpopClient(grant: UploadGrant) {
  const key = await crypto.subtle.importKey('jwk', grant.dpopKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicJwk = { kty: 'EC', crv: 'P-256', x: grant.dpopKey.x, y: grant.dpopKey.y };
  const ath = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(grant.accessToken))));
  let nonce: string | null = null;

  async function proof(method: string, url: string): Promise<string> {
    const target = new URL(url);
    const payload: Record<string, unknown> = {
      jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
      htm: method,
      htu: `${target.origin}${target.pathname}`,
      iat: Math.floor(Date.now() / 1000),
      ath,
    };
    if (nonce) payload.nonce = nonce;
    const input = `${base64url(utf8(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk })))}.${base64url(utf8(JSON.stringify(payload)))}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));
    return `${input}.${base64url(new Uint8Array(signature))}`;
  }

  return {
    async fetch(url: string, init: RequestInit & { method: string }): Promise<Response> {
      // The server names a nonce on first contact; retry once with it.
      for (let attempt = 0; ; attempt++) {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `DPoP ${grant.accessToken}`);
        headers.set('DPoP', await proof(init.method, url));
        const response = await fetch(url, { ...init, headers, credentials: 'omit' });
        const next = response.headers.get('DPoP-Nonce');
        if (next) nonce = next;
        const wantsNonce =
          (response.status === 401 || response.status === 400) &&
          (response.headers.get('WWW-Authenticate') ?? '').includes('use_dpop_nonce');
        if (attempt === 0 && wantsNonce && next) continue;
        return response;
      }
    },
  };
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

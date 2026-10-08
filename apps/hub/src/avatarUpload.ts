/**
 * "Upload from device", the browser half (see docs/avatar-wallet.md).
 *
 * The visitor's .vrm or .glb goes from this browser straight to their own
 * AT Protocol account as an at3d avatar. WorldMesh never receives the bytes:
 * the Worker hands over a short-lived, upload-only token (DPoP-bound, so it
 * comes with its key), and afterwards creates the record that points at the
 * uploaded file.
 *
 * Authorizing means leaving the page, so the chosen file waits in this
 * browser's IndexedDB until the visitor comes back.
 */

export type ModelFormat = 'vrm' | 'glb';

export interface ModelFile {
  file: Blob;
  name: string;
  format: ModelFormat;
  vrmVersion: '0.x' | '1.0' | null;
}

/** Where the Worker says to send the file (POST /api/account/avatar/upload/session). */
export interface UploadTarget {
  url: string;
  accessToken: string;
  dpopKey: JsonWebKey;
}

/** at3d's limits for the model file (app.at3d.avatar#vrmAppearance / #gltfAppearance). */
export const MAX_MODEL_BYTES: Record<ModelFormat, number> = { vrm: 15 * 1024 * 1024, glb: 10 * 1024 * 1024 };
/** How the file is labelled on upload: at3d types VRM as octet-stream. */
const CONTENT_TYPE: Record<ModelFormat, string> = { vrm: 'application/octet-stream', glb: 'model/gltf-binary' };

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"

/** Checks the file is a GLB container (VRM is one too) within at3d's limits. Errors are user-facing. */
export async function inspectModel(file: File): Promise<ModelFile> {
  if (!/\.(vrm|glb)$/i.test(file.name)) throw new Error('Choose a .vrm or .glb file.');
  const notAModel = new Error('This file is not a VRM or GLB character.');
  if (file.size < 20) throw notAModel;
  const header = new DataView(await file.slice(0, 20).arrayBuffer());
  const jsonLength = header.getUint32(12, true);
  if (
    header.getUint32(0, true) !== GLB_MAGIC ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(16, true) !== JSON_CHUNK ||
    jsonLength > file.size - 20
  ) {
    throw notAModel;
  }
  let gltf: { extensions?: Record<string, unknown> };
  try {
    gltf = JSON.parse(await file.slice(20, 20 + jsonLength).text()) as typeof gltf;
  } catch {
    throw notAModel;
  }
  // The contents decide, not the extension: VRM 1.0 uses VRMC_vrm, VRM 0.x uses VRM.
  const extensions = gltf?.extensions ?? {};
  const vrmVersion = 'VRMC_vrm' in extensions ? '1.0' : 'VRM' in extensions ? '0.x' : null;
  const format: ModelFormat = vrmVersion ? 'vrm' : 'glb';
  if (file.size > MAX_MODEL_BYTES[format]) {
    const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    throw new Error(`This character is ${mb(file.size)} MB. ${format.toUpperCase()} characters can be up to ${mb(MAX_MODEL_BYTES[format])} MB.`);
  }
  // The character's own name (VRM 1.0 meta.name, VRM 0.x meta.title) beats a file name like "2837576971040646108".
  const meta = (extensions.VRMC_vrm ?? extensions.VRM) as { meta?: { name?: unknown; title?: unknown } } | undefined;
  const named = [meta?.meta?.name, meta?.meta?.title].find((n): n is string => typeof n === 'string' && !!n.trim());
  return { file, name: (named ?? file.name.replace(/\.(vrm|glb)$/i, '')).trim(), format, vrmVersion };
}

/**
 * Sends the file to the account and returns the blob reference it answers
 * with. The server's DPoP nonce comes from a bodiless first request, so the
 * file itself is sent once.
 */
export async function sendModel(target: UploadTarget, model: ModelFile): Promise<unknown> {
  const send = async (nonce: string | null, body: Blob | null) =>
    fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPE[model.format],
        Authorization: `DPoP ${target.accessToken}`,
        DPoP: await dpopProof(target.dpopKey, target.url, nonce, target.accessToken),
      },
      body,
    });
  const needsNonce = (response: Response) =>
    (response.status === 401 || response.status === 400) && /use_dpop_nonce/.test(response.headers.get('WWW-Authenticate') ?? '');

  let nonce = (await send(null, new Blob([]))).headers.get('DPoP-Nonce');
  for (let attempt = 0; ; attempt++) {
    const response = await send(nonce, model.file);
    const fresh = response.headers.get('DPoP-Nonce');
    if (attempt < 1 && needsNonce(response) && fresh) {
      nonce = fresh;
      continue;
    }
    if (response.status === 413) throw new Error('This file is larger than your account accepts. Try a smaller character.');
    if (response.status === 401 || response.status === 403) throw new Error('Your account did not allow the upload. Please try again.');
    const body = (await response.json().catch(() => null)) as { blob?: unknown } | null;
    if (!response.ok || !body?.blob) throw new Error('Your account could not take the file. Try again later.');
    return body.blob;
  }
}

async function dpopProof(privateJwk: JsonWebKey, url: string, nonce: string | null, accessToken: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const target = new URL(url);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y } };
  const payload: Record<string, unknown> = {
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    htm: 'POST',
    htu: `${target.origin}${target.pathname}`,
    iat: Math.floor(Date.now() / 1000),
    ath: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(accessToken)))),
  };
  if (nonce) payload.nonce = nonce;
  const input = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Waiting room for the file while the visitor authorizes ──────────────────
// Local to this browser, gone once uploaded, and ignored after 30 minutes.

const DB_NAME = 'worldmesh-avatar-upload';
const STORE = 'pending';
const KEY = 'model';
const STASH_MS = 30 * 60_000;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = use(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps the file for after authorization. False when this browser cannot (the visitor picks it again). */
export async function stashModel(model: ModelFile): Promise<boolean> {
  try {
    await withStore('readwrite', (store) => store.put({ ...model, savedAt: Date.now() }, KEY));
    return true;
  } catch {
    return false;
  }
}

/** The kept file, if there is a recent one. */
export async function stashedModel(): Promise<ModelFile | null> {
  try {
    const value = (await withStore('readonly', (store) => store.get(KEY))) as (ModelFile & { savedAt: number }) | undefined;
    if (!value || !(value.file instanceof Blob) || Date.now() - value.savedAt > STASH_MS) return null;
    return { file: value.file, name: value.name, format: value.format, vrmVersion: value.vrmVersion };
  } catch {
    return null;
  }
}

export async function clearStashedModel(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    // Nothing kept, or storage blocked.
  }
}

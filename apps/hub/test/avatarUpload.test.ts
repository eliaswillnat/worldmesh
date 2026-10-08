import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectModel, MAX_MODEL_BYTES, sendModel } from '../src/avatarUpload';

/** A minimal GLB container: header, JSON chunk, and `padding` extra bytes. */
function glb(json: unknown, padding = 0): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(20 + body.length + padding);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, body.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(body, 20);
  return bytes;
}

const file = (bytes: Uint8Array, name: string) => new File([bytes], name);

describe('inspectModel', () => {
  it('tells VRM 1.0, VRM 0.x and plain GLB apart by their contents', async () => {
    expect(await inspectModel(file(glb({ asset: { version: '2.0' }, extensions: { VRMC_vrm: {} } }), 'Aoi.vrm'))).toMatchObject({
      name: 'Aoi',
      format: 'vrm',
      vrmVersion: '1.0',
    });
    expect(await inspectModel(file(glb({ extensions: { VRM: {} } }), 'old.VRM'))).toMatchObject({ format: 'vrm', vrmVersion: '0.x' });
    expect(await inspectModel(file(glb({ asset: { version: '2.0' } }), 'Robo Knight.glb'))).toMatchObject({
      name: 'Robo Knight',
      format: 'glb',
      vrmVersion: null,
    });
  });

  it('refuses other files and anything over at3d’s limits', async () => {
    await expect(inspectModel(file(glb({}), 'model.fbx'))).rejects.toThrow('Choose a .vrm or .glb file.');
    await expect(inspectModel(file(new TextEncoder().encode('{"asset":{"version":"2.0"}} and more'), 'scene.glb'))).rejects.toThrow(
      'not a VRM or GLB',
    );
    await expect(inspectModel(file(glb({}, MAX_MODEL_BYTES.glb), 'big.glb'))).rejects.toThrow('can be up to 10 MB');
    // The same size is fine for a VRM, which may be up to 15 MB.
    await expect(inspectModel(file(glb({ extensions: { VRM: {} } }, MAX_MODEL_BYTES.glb), 'big.vrm'))).resolves.toMatchObject({
      format: 'vrm',
    });
  });
});

describe('sendModel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets the nonce without the file, then sends the file once with a token-bound DPoP proof', async () => {
    const key = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const dpopKey = await crypto.subtle.exportKey('jwk', key.privateKey);
    const requests: { headers: Headers; size: number }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const size = (init.body as Blob).size;
      const headers = new Headers(init.headers);
      requests.push({ headers, size });
      const proof = JSON.parse(atob(headers.get('DPoP')!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!proof.nonce) {
        return new Response('{"error":"use_dpop_nonce"}', {
          status: 401,
          headers: { 'DPoP-Nonce': 'n-1', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
        });
      }
      expect(proof).toMatchObject({ htm: 'POST', htu: 'https://pds.example.com/xrpc/com.atproto.repo.uploadBlob', nonce: 'n-1' });
      expect(typeof proof.ath).toBe('string');
      return Response.json({ blob: { $type: 'blob', ref: { $link: 'bafkrei' }, mimeType: 'model/gltf-binary', size } });
    });
    const model = await inspectModel(file(glb({ extensions: { VRMC_vrm: {} } }, 1000), 'a.vrm'));
    const blob = await sendModel({ url: 'https://pds.example.com/xrpc/com.atproto.repo.uploadBlob', accessToken: 'tok', dpopKey }, model);
    expect(blob).toMatchObject({ ref: { $link: 'bafkrei' } });
    expect(requests.map((r) => r.size)).toEqual([0, model.file.size]);
    expect(requests[1].headers.get('Authorization')).toBe('DPoP tok');
    expect(requests[1].headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

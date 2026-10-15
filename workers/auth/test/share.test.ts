import { describe, expect, it } from 'vitest';
import { fromBase64url } from '../src/avatars/crypto';
import { mayShare, shareKey, sharePayload, signShare } from '../src/avatars/share';
import type { AvatarDescriptor } from '../src/avatars/types';

const SECRET = 'avatar-secret-avatar-secret-avatar-secret';

function descriptor(provider: AvatarDescriptor['provider'], modelUrl: string, expiresAt: string | null = null): AvatarDescriptor {
  return { provider, avatarId: 'model-1', name: null, thumbnail: null, format: 'glb', modelUrl, expiresAt, sourceUrl: null };
}

async function verifies(share: { u: string; f: string; i: string; x: number; s: string }, secret = SECRET): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', await shareKey(secret), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64url(share.s), sharePayload(share.u, share.f, share.i, share.x));
}

describe('avatar share signing', () => {
  it('only vouches for links WorldMesh got from a platform itself', () => {
    expect(mayShare(descriptor('sketchfab', 'https://sketchfab-prod-media.s3.amazonaws.com/m.glb?X-Amz-Signature=a'))).toBe(true);
    expect(mayShare(descriptor('atproto', 'https://morel.us-east.host.bsky.network/xrpc/com.atproto.sync.getBlob?did=x&cid=y'))).toBe(true);
    expect(mayShare(descriptor('atproto', 'https://bsky.social/xrpc/com.atproto.sync.getBlob?did=x&cid=y'))).toBe(true);
    // Self-hosted PDS: could be a server that logs who downloads from it.
    expect(mayShare(descriptor('atproto', 'https://pds.someone.example/xrpc/com.atproto.sync.getBlob?did=x&cid=y'))).toBe(false);
    expect(mayShare(descriptor('atproto', 'https://evil.host.bsky.network.example/x'))).toBe(false);
    expect(mayShare(descriptor('atproto', 'https://evilhost.bsky.network/x'))).toBe(false);
    // VRoid: license allows the requesting user only.
    expect(mayShare(descriptor('vroid', 'https://vroid-hub.s3.ap-northeast-1.amazonaws.com/m.vrm'))).toBe(false);
    expect(mayShare(descriptor('sketchfab', 'http://sketchfab-prod-media.s3.amazonaws.com/m.glb'))).toBe(false);
  });

  it('signs a link that verifies, and nothing else verifies', async () => {
    const share = (await signShare(SECRET, descriptor('sketchfab', 'https://sketchfab-prod-media.s3.amazonaws.com/m.glb')))!;
    expect(share.s).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifies(share)).toBe(true);
    expect(await verifies({ ...share, u: 'https://evil.example/m.glb' })).toBe(false);
    expect(await verifies({ ...share, x: share.x + 3600 })).toBe(false);
    expect(await verifies({ ...share, f: 'vrm' })).toBe(false);
    expect(await verifies(share, 'another-secret-another-secret-another-1')).toBe(false);
  });

  it('expires with the link, at most two hours out', async () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const soon = new Date(now + 300_000).toISOString();
    const short = (await signShare(SECRET, descriptor('sketchfab', 'https://s3.example/m.glb', soon), now))!;
    expect(short.x).toBe(Math.floor((now + 300_000) / 1000));
    const long = (await signShare(SECRET, descriptor('atproto', 'https://bsky.social/xrpc/x'), now))!;
    expect(long.x).toBe(Math.floor(now / 1000) + 2 * 3600);
  });

  it('gives the same avatar the same id, whatever the link', async () => {
    const a = (await signShare(SECRET, descriptor('sketchfab', 'https://s3.example/m.glb?sig=1')))!;
    const b = (await signShare(SECRET, descriptor('sketchfab', 'https://s3.example/m.glb?sig=2')))!;
    expect(a.i).toBe(b.i);
    expect(a.i).toMatch(/^[0-9a-f]{16}$/);
  });
});

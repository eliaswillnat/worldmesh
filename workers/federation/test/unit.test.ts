import { describe, expect, it } from 'vitest';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  generateActorKeys,
  importPrivateKey,
  importPublicKey,
} from '../src/crypto/keys';
import { parseSignatureHeader, signRequest, verifyRequest, type KeyResolver } from '../src/crypto/signatures';
import { assertPublicUrl, parseJsonObject, UnsafeUrlError } from '../src/net/safe-fetch';
import { parseActor } from '../src/remote';
import type { Env } from '../src/env';

const SECRET = 'unit-test-secret-unit-test-secret-1234';

describe('private keys at rest', () => {
  it('round-trips, and is bound to the actor id', async () => {
    const keys = await generateActorKeys();
    const stored = await encryptPrivateKey(SECRET, 'actor-a', keys.privateKeyPkcs8);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('PRIVATE');
    const back = await decryptPrivateKey(SECRET, 'actor-a', stored);
    expect(new Uint8Array(back)).toEqual(new Uint8Array(keys.privateKeyPkcs8));
    await expect(decryptPrivateKey(SECRET, 'actor-b', stored)).rejects.toThrow();
    await expect(decryptPrivateKey(`${SECRET}x`, 'actor-a', stored)).rejects.toThrow();
  });
});

describe('assertPublicUrl (SSRF guard)', () => {
  const own = 'worldmesh.net';
  it.each([
    'http://mastodon.social/users/a',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://[fd00::1]/inbox',
    'https://localhost/',
    'https://metadata.google.internal/',
    'https://printer.local/',
    'https://intranet/',
    'https://mastodon.social:8443/inbox',
    'https://user:pass@mastodon.social/',
    'https://worldmesh.net/ap/inbox',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertPublicUrl(url, own)).toThrow(UnsafeUrlError);
  });

  it.each(['https://mastodon.social/users/alice', 'https://pixelfed.social:443/users/bob#main-key'])('allows %s', (url) => {
    expect(assertPublicUrl(url, own).protocol).toBe('https:');
  });
});

describe('parseJsonObject', () => {
  it('refuses non-objects and absurd nesting', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parseJsonObject(enc('[1,2]'))).toBeNull();
    expect(parseJsonObject(enc('"x"'))).toBeNull();
    expect(parseJsonObject(enc('{bad'))).toBeNull();
    expect(parseJsonObject(enc(`${'{"a":'.repeat(40)}1${'}'.repeat(40)}`))).toBeNull();
    expect(parseJsonObject(enc('{"type":"Follow"}'))).toEqual({ type: 'Follow' });
  });
});

describe('HTTP signatures', () => {
  it('parses Mastodon-style headers and refuses garbage', () => {
    const parsed = parseSignatureHeader(
      'keyId="https://a.social/users/x#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="AAEC"',
    );
    expect(parsed).toMatchObject({ keyId: 'https://a.social/users/x#main-key', headers: ['(request-target)', 'host', 'date', 'digest'] });
    expect(parseSignatureHeader('keyId="a",keyId="b",signature="AAEC"')).toBeNull();
    expect(parseSignatureHeader('signature="AAEC"')).toBeNull();
    expect(parseSignatureHeader('keyId="a",signature="AAEC" trailing')).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });

  async function signedPost(body: string, overrides: { now?: Date; host?: string } = {}) {
    const keys = await generateActorKeys();
    const privateKey = await importPrivateKey(keys.privateKeyPkcs8);
    const url = 'https://worldmesh.net/ap/inbox';
    const headers = await signRequest({
      method: 'POST',
      url: overrides.host ? `https://${overrides.host}/ap/inbox` : url,
      headers: new Headers({ 'Content-Type': 'application/activity+json' }),
      body,
      keyId: 'https://a.social/users/x#main-key',
      privateKey,
      now: overrides.now,
    });
    const publicKey = await importPublicKey(keys.publicKeyPem);
    const resolver: KeyResolver = async () => ({ key: publicKey, owner: 'https://a.social/users/x', fresh: true });
    const request = new Request(url, { method: 'POST', headers, body });
    return { request, resolver, publicKey, body: new TextEncoder().encode(body) };
  }

  it('verifies what it signs', async () => {
    const { request, resolver, body } = await signedPost('{"type":"Follow"}');
    expect(await verifyRequest(request, body, 'worldmesh.net', resolver)).toEqual({
      ok: true,
      keyId: 'https://a.social/users/x#main-key',
      owner: 'https://a.social/users/x',
    });
  });

  it('refuses a body that does not match the signed digest', async () => {
    const { request, resolver } = await signedPost('{"type":"Follow"}');
    const tampered = new TextEncoder().encode('{"type":"Delete"}');
    expect(await verifyRequest(request, tampered, 'worldmesh.net', resolver)).toEqual({ ok: false, reason: 'digest-mismatch' });
  });

  it('refuses signatures older than 12 hours (replays)', async () => {
    const { request, resolver, body } = await signedPost('{}', { now: new Date(Date.now() - 13 * 3600_000) });
    expect(await verifyRequest(request, body, 'worldmesh.net', resolver)).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a signature made for another host', async () => {
    const { request, resolver, body } = await signedPost('{}', { host: 'other.social' });
    const verdict = await verifyRequest(request, body, 'worldmesh.net', resolver);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a POST whose signature does not cover the digest', async () => {
    const request = new Request('https://worldmesh.net/ap/inbox', {
      method: 'POST',
      headers: {
        Date: new Date().toUTCString(),
        Signature: 'keyId="https://a.social/users/x#main-key",headers="(request-target) host date",signature="AAEC"',
      },
      body: '{}',
    });
    const resolver: KeyResolver = async () => null;
    expect(await verifyRequest(request, new TextEncoder().encode('{}'), 'worldmesh.net', resolver)).toEqual({
      ok: false,
      reason: 'insufficient-headers',
    });
  });

  it('refetches a cached key once when the signature fails (key rotation)', async () => {
    const { request, body, publicKey } = await signedPost('{}');
    const rotatedAway = await importPublicKey((await generateActorKeys()).publicKeyPem);
    const calls: boolean[] = [];
    const resolver: KeyResolver = async (_keyId, refresh) => {
      calls.push(refresh);
      return refresh ? { key: publicKey, owner: 'x', fresh: true } : { key: rotatedAway, owner: 'x', fresh: false };
    };
    expect((await verifyRequest(request, body, 'worldmesh.net', resolver)).ok).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  it('does not refetch a key it just fetched', async () => {
    const { request, body } = await signedPost('{}');
    const wrong = await importPublicKey((await generateActorKeys()).publicKeyPem);
    let calls = 0;
    const resolver: KeyResolver = async () => {
      calls++;
      return { key: wrong, owner: 'x', fresh: true };
    };
    expect(await verifyRequest(request, body, 'worldmesh.net', resolver)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(calls).toBe(1);
  });
});

describe('parseActor', () => {
  const env = { FEDERATION_ORIGIN: 'https://worldmesh.net', FEDERATION_DOMAIN: 'worldmesh.net' } as Env;
  const actor = (overrides: Record<string, unknown> = {}) => ({
    id: 'https://a.social/users/x',
    type: 'Person',
    inbox: 'https://a.social/users/x/inbox',
    endpoints: { sharedInbox: 'https://a.social/inbox' },
    publicKey: { id: 'https://a.social/users/x#main-key', owner: 'https://a.social/users/x', publicKeyPem: 'PEM' },
    ...overrides,
  });

  it('accepts a well-formed actor', () => {
    expect(parseActor(env, actor(), 'https://a.social/users/x')).toMatchObject({
      inbox: 'https://a.social/users/x/inbox',
      shared_inbox: 'https://a.social/inbox',
      key_id: 'https://a.social/users/x#main-key',
    });
  });

  it('refuses documents that are not what was asked for', () => {
    expect(parseActor(env, actor(), 'https://a.social/users/y')).toBeNull();
    expect(parseActor(env, actor({ type: 'Note' }), 'https://a.social/users/x')).toBeNull();
  });

  it('refuses keys owned by someone else', () => {
    const publicKey = { id: 'https://a.social/users/x#main-key', owner: 'https://b.social/users/z', publicKeyPem: 'PEM' };
    expect(parseActor(env, actor({ publicKey }), 'https://a.social/users/x')).toBeNull();
  });

  it('refuses inboxes on other hosts or private addresses', () => {
    expect(parseActor(env, actor({ inbox: 'https://victim.example.com/hook' }), 'https://a.social/users/x')).toBeNull();
    expect(parseActor(env, actor({ inbox: 'https://127.0.0.1/inbox' }), 'https://a.social/users/x')).toBeNull();
    const offHostShared = parseActor(env, actor({ endpoints: { sharedInbox: 'https://victim.example.com/' } }), 'https://a.social/users/x');
    expect(offHostShared?.shared_inbox).toBeNull();
  });
});

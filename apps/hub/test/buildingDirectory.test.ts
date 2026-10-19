import { describe, expect, it } from 'vitest';
import { approvedFrom, resolvedFrom } from '../src/walk/buildingDirectory';

const HASH = '081ddacf9b8120147f44d06cc6eecded7e3ccecca8bc8af7f7f76704a20fc68a';

describe('approved buildings', () => {
  it('maps each world to the hash its building must have, leaving out anything malformed', () => {
    const approved = approvedFrom({
      worlds: [
        { url: 'https://forest.example.org', sha256: HASH },
        { url: 'https://short-hash.example.org', sha256: 'abc' },
        { url: 'https://upper.example.org', sha256: HASH.toUpperCase() },
        { sha256: HASH },
        null,
      ],
    });
    expect([...approved]).toEqual([['https://forest.example.org', HASH]]);
    expect(approvedFrom(null).size).toBe(0);
    expect(approvedFrom({ worlds: 'nope' }).size).toBe(0);
  });
});

describe('resolved buildings', () => {
  it('keeps https links with a hash, and when they expire', () => {
    const resolved = resolvedFrom({
      buildings: {
        'https://forest.example.org': { modelUrl: 'https://s3.example.com/model.glb?sig=1', expiresAt: '2026-10-19T12:05:00.000Z', sha256: HASH },
        'https://pds.example.org': { modelUrl: 'https://pds.example.org/xrpc/com.atproto.sync.getBlob?did=x&cid=y', expiresAt: null, sha256: HASH },
        'https://plain.example.org': { modelUrl: 'http://insecure.example.com/model.glb', expiresAt: null, sha256: HASH },
        'https://nohash.example.org': { modelUrl: 'https://s3.example.com/model.glb', expiresAt: null },
      },
    });
    expect([...resolved.keys()]).toEqual(['https://forest.example.org', 'https://pds.example.org']);
    expect(resolved.get('https://forest.example.org')!.expiresAt).toBe(Date.parse('2026-10-19T12:05:00.000Z'));
    expect(resolved.get('https://pds.example.org')!.expiresAt).toBeNull();
    expect(resolvedFrom({}).size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  HUB_NOCOUNT_KEY,
  isProductionHubHost,
  shouldCountHubVisit,
  syncHubNocountFromQuery,
} from '../src/hubVisit';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

describe('isProductionHubHost', () => {
  it('allows only worldmesh.net and www', () => {
    expect(isProductionHubHost('worldmesh.net')).toBe(true);
    expect(isProductionHubHost('www.worldmesh.net')).toBe(true);
  });

  it('rejects localhost, pages previews, and other hosts', () => {
    expect(isProductionHubHost('localhost')).toBe(false);
    expect(isProductionHubHost('127.0.0.1')).toBe(false);
    expect(isProductionHubHost('worldmesh.pages.dev')).toBe(false);
    expect(isProductionHubHost('abc.worldmesh.pages.dev')).toBe(false);
    expect(isProductionHubHost('staging.worldmesh.net')).toBe(false);
  });
});

describe('syncHubNocountFromQuery', () => {
  it('sets the flag for ?wm_nocount=1', () => {
    const storage = memoryStorage();
    syncHubNocountFromQuery('?wm_nocount=1', storage);
    expect(storage.getItem(HUB_NOCOUNT_KEY)).toBe('1');
  });

  it('clears the flag for ?wm_nocount=0', () => {
    const storage = memoryStorage({ [HUB_NOCOUNT_KEY]: '1' });
    syncHubNocountFromQuery('wm_nocount=0', storage);
    expect(storage.getItem(HUB_NOCOUNT_KEY)).toBe(null);
  });

  it('leaves storage alone when the param is absent', () => {
    const storage = memoryStorage({ [HUB_NOCOUNT_KEY]: '1' });
    syncHubNocountFromQuery('', storage);
    expect(storage.getItem(HUB_NOCOUNT_KEY)).toBe('1');
  });
});

describe('shouldCountHubVisit', () => {
  it('counts on production without opt-out', () => {
    expect(shouldCountHubVisit('worldmesh.net', '', memoryStorage())).toBe(true);
    expect(shouldCountHubVisit('www.worldmesh.net', '', memoryStorage())).toBe(true);
  });

  it('skips non-production hosts', () => {
    expect(shouldCountHubVisit('localhost', '', memoryStorage())).toBe(false);
    expect(shouldCountHubVisit('foo.pages.dev', '', memoryStorage())).toBe(false);
  });

  it('skips production when ?wm_nocount=1 is set (and persists)', () => {
    const storage = memoryStorage();
    expect(shouldCountHubVisit('worldmesh.net', '?wm_nocount=1', storage)).toBe(false);
    expect(storage.getItem(HUB_NOCOUNT_KEY)).toBe('1');
    // Later load without the query still skips.
    expect(shouldCountHubVisit('worldmesh.net', '', storage)).toBe(false);
  });

  it('resumes counting after ?wm_nocount=0', () => {
    const storage = memoryStorage({ [HUB_NOCOUNT_KEY]: '1' });
    expect(shouldCountHubVisit('worldmesh.net', '?wm_nocount=0', storage)).toBe(true);
  });
});

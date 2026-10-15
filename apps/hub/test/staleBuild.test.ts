import { describe, expect, it } from 'vitest';
import { STALE_BUILD_RELOAD_KEY, STALE_BUILD_RELOAD_WINDOW_MS, claimStaleBuildReload } from '../src/staleBuild';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

describe('claimStaleBuildReload', () => {
  const now = 1_800_000_000_000;

  it('reloads the first time and records when', () => {
    const storage = memoryStorage();
    expect(claimStaleBuildReload(storage, now)).toBe(true);
    expect(storage.snapshot()).toEqual({ [STALE_BUILD_RELOAD_KEY]: String(now) });
  });

  it('never reloads twice within the window', () => {
    const storage = memoryStorage();
    expect(claimStaleBuildReload(storage, now)).toBe(true);
    expect(claimStaleBuildReload(storage, now + 3_000)).toBe(false);
    expect(claimStaleBuildReload(storage, now + STALE_BUILD_RELOAD_WINDOW_MS - 1)).toBe(false);
    // Saying no leaves the first reload's time in place.
    expect(storage.snapshot()).toEqual({ [STALE_BUILD_RELOAD_KEY]: String(now) });
  });

  it('reloads again for a later deploy', () => {
    const storage = memoryStorage({ [STALE_BUILD_RELOAD_KEY]: String(now) });
    expect(claimStaleBuildReload(storage, now + STALE_BUILD_RELOAD_WINDOW_MS)).toBe(true);
    expect(storage.snapshot()).toEqual({ [STALE_BUILD_RELOAD_KEY]: String(now + STALE_BUILD_RELOAD_WINDOW_MS) });
  });

  it('ignores an unreadable or future time', () => {
    expect(claimStaleBuildReload(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: 'junk' }), now)).toBe(true);
    expect(claimStaleBuildReload(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: String(now + 5_000) }), now)).toBe(true);
  });

  it('lets a storage failure through for the caller to treat as no', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => claimStaleBuildReload(storage, now)).toThrow();
  });
});

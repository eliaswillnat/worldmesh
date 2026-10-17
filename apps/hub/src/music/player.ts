import { TRACKS, trackUrl, type Track } from './tracks';

/** Remembered per browser: someone who turned the music off keeps it off. */
const MUSIC_KEY = 'worldmesh.music';
/** Background level, under the lobby's footsteps and chat sounds. */
const VOLUME = 0.35;

export interface LobbyMusic {
  /** Whether this browser can play the files at all (Ogg Vorbis). */
  readonly supported: boolean;
  /** The visitor's choice, on unless they turned it off. */
  readonly enabled: boolean;
  /** The song playing or paused, if the playlist has started. */
  readonly current: Track | null;
  /** Plays while the lobby is open, and pauses where it was when it closes. */
  setActive(active: boolean): void;
  setEnabled(enabled: boolean): void;
  /** Called with the current song whenever it or the on/off choice changes. */
  onChange(listener: () => void): void;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function savedEnabled(): boolean {
  try {
    return localStorage.getItem(MUSIC_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * The lobby's playlist: every song in tracks.ts, shuffled, one after another,
 * played only while the lobby is open and the tab is visible. Browsers hold
 * audio back until the visitor does something, so a refused start waits for
 * their first click, key or tap.
 */
export function createLobbyMusic(): LobbyMusic {
  const audio = new Audio();
  audio.preload = 'none';
  audio.volume = VOLUME;
  const supported = TRACKS.length > 0 && audio.canPlayType('audio/ogg; codecs="vorbis"') !== '';
  let enabled = savedEnabled();
  let active = false;
  let queue: Track[] = [];
  let current: Track | null = null;
  /** Songs in a row that would not load; after a whole round of them, stop trying (offline, most likely). */
  let failures = 0;
  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((listener) => listener());

  function next(): void {
    if (queue.length === 0) {
      queue = shuffled(TRACKS);
      // Never the same song twice in a row across a reshuffle.
      if (queue.length > 1 && queue[0] === current) queue.push(queue.shift()!);
    }
    current = queue.shift()!;
    audio.src = trackUrl(current);
    changed();
  }

  const shouldPlay = () => supported && enabled && active && document.visibilityState === 'visible';

  let waiting = false;
  function waitForGesture(): void {
    if (waiting) return;
    waiting = true;
    const retry = () => {
      waiting = false;
      for (const type of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(type, retry, true);
      sync();
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, retry, { capture: true });
  }

  function sync(): void {
    if (!shouldPlay()) {
      audio.pause();
      return;
    }
    if (!current) next();
    if (!audio.paused) return;
    audio.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotAllowedError') waitForGesture();
    });
  }

  audio.addEventListener('ended', () => {
    next();
    sync();
  });
  audio.addEventListener('playing', () => {
    failures = 0;
  });
  // A file that will not load: skip it rather than going quiet.
  audio.addEventListener('error', () => {
    if (!current || !shouldPlay()) return;
    console.warn(`Lobby music: could not play ${current.file}`);
    if (++failures >= TRACKS.length) return;
    next();
    sync();
  });
  document.addEventListener('visibilitychange', sync);

  return {
    supported,
    get enabled() {
      return enabled;
    },
    get current() {
      return current;
    },
    setActive(value) {
      active = value;
      sync();
    },
    setEnabled(value) {
      enabled = value;
      try {
        if (value) localStorage.removeItem(MUSIC_KEY);
        else localStorage.setItem(MUSIC_KEY, 'off');
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
      sync();
      changed();
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

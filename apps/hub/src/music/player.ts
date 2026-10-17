import { audio as lobbyAudio } from '../walk/sounds';
import { EPOCH_MS, slotLevel, slotsBetween, type Slot } from './schedule';
import { audible, createHallMix, distanceToSource, hearing, type HallMix } from './space';
import { TRACKS, trackUrl, type Track } from './tracks';

/** Remembered per browser: someone who turned the music off keeps it off. */
const MUSIC_KEY = 'worldmesh.music';
/**
 * Background level, well under the lobby's footsteps and chat sounds. The
 * hall's reverberation adds to it: in the middle of the hall the music comes
 * out at about 1.8× this, half the level the lobby music had before.
 */
const VOLUME = 0.05;
/** Seconds ahead a coming song starts loading, so it is ready for its crossfade. */
const LOOKAHEAD_S = 10;
/** Seconds off the timetable before a song is put back in step. */
const DRIFT_S = 1;
/** Seconds the music takes to die away once it should stop (turned off, out of earshot). */
const ROOM_FADE_S = 1.5;
const TICK_MS = 250;

export interface LobbyMusic {
  /** Whether this browser can play the files at all (Ogg Vorbis). */
  readonly supported: boolean;
  /** The visitor's choice, on unless they turned it off. */
  readonly enabled: boolean;
  /** The song playing now (the incoming one during a crossfade), or null. */
  readonly current: Track | null;
  /** The lobby is open (walk mode). */
  setActive(active: boolean): void;
  /**
   * Where the visitor stands (feet), and the hall's radius. The music comes
   * from the middle of the hall: loudest there, fading out past the wall.
   */
  setListener(x: number, y: number, z: number, hallRadius: number): void;
  setEnabled(enabled: boolean): void;
  /** Called whenever the song or the on/off choice changes. */
  onChange(listener: () => void): void;
}

/** One of two players, so a song can fade out while the next fades in. */
interface Deck {
  element: HTMLAudioElement;
  level: GainNode;
  slot: Slot | null;
  /** This slot's file would not load: stay quiet until the next song. */
  broken: boolean;
}

function savedEnabled(): boolean {
  try {
    return localStorage.getItem(MUSIC_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * How far this browser's clock is from the server's, in milliseconds, from
 * the Date header of a tiny request. Good to about half a second, which is
 * close enough for background music. 0 if it cannot tell.
 */
async function clockOffset(): Promise<number> {
  try {
    const sent = Date.now();
    const response = await fetch('/', { method: 'HEAD', cache: 'no-store' });
    const received = Date.now();
    const date = Date.parse(response.headers.get('date') ?? '');
    // The header is whole seconds: add half of one.
    return Number.isNaN(date) ? 0 : date + 500 - (sent + received) / 2;
  } catch {
    return 0;
  }
}

/**
 * The lobby's music: everyone hears the same song at the same moment (see
 * schedule.ts), crossfading from one song to the next. It comes from the
 * middle of the hall and sounds like the hall (see space.ts): loudest there,
 * softer towards the wall, muffled and fading as you walk away outside. It
 * plays only within earshot of the hall, with the tab in view.
 */
export function createLobbyMusic(): LobbyMusic {
  const supported = TRACKS.length > 0 && new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '';
  let enabled = savedEnabled();
  let active = false;
  /** Metres from the music, and the hall's radius; out of earshot until the lobby says. */
  let distance = Infinity;
  let radius = 1;
  let current: Track | null = null;
  let offset: number | null = null;
  let askedClock = false;
  let timer = 0;
  /** Seconds of context time when the music last began fading away, or -1. */
  let fadingSince = -1;
  let decks: Deck[] = [];
  let mix: HallMix | null = null;
  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((listener) => listener());

  const shouldPlay = () => supported && enabled && active && audible(distance, radius) && document.visibilityState === 'visible';
  /** Seconds since the timetable began, on the server's clock. */
  const now = () => (Date.now() + (offset ?? 0) - EPOCH_MS) / 1000;

  /** The mixing desk, built on first use inside the lobby's own audio context. */
  function desk(): AudioContext | null {
    const context = lobbyAudio();
    if (!context || mix) return context;
    const hall = createHallMix(context, context.destination);
    mix = hall;
    decks = [0, 1].map(() => {
      const element = new Audio();
      element.preload = 'none';
      const level = context.createGain();
      level.gain.value = 0;
      context.createMediaElementSource(element).connect(level).connect(hall.input);
      const deck: Deck = { element, level, slot: null, broken: false };
      // A file that will not load: skip it and let the timetable move on.
      element.addEventListener('error', () => {
        if (!deck.slot) return;
        deck.broken = true;
        console.warn(`Lobby music: could not play ${deck.slot.track.file}`);
      });
      return deck;
    });
    return context;
  }

  let waiting = false;
  /** Browsers hold audio back until the visitor does something: try again then. */
  function waitForGesture(): void {
    if (waiting) return;
    waiting = true;
    const retry = () => {
      waiting = false;
      for (const type of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(type, retry, true);
      tick();
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, retry, { capture: true });
  }

  function release(deck: Deck): void {
    deck.slot = null;
    deck.broken = false;
    deck.element.pause();
    deck.element.removeAttribute('src');
    deck.element.load();
  }

  function tick(): void {
    const context = desk();
    if (!context || !mix) return;
    const playing = shouldPlay();
    const at = context.currentTime;
    mix.hear(hearing(distance, radius), playing ? VOLUME : 0);

    if (!playing) {
      // Faded out: let go of the files until the visitor is back within earshot.
      if (fadingSince < 0) fadingSince = at;
      if (at - fadingSince > ROOM_FADE_S * 1.5 || document.visibilityState !== 'visible') {
        for (const deck of decks) deck.element.pause();
        stop();
      }
      return;
    }
    fadingSince = -1;
    if (offset === null) return;

    const time = now();
    const wanted = slotsBetween(TRACKS, time, time + LOOKAHEAD_S).slice(0, decks.length);
    const same = (a: Slot | null, b: Slot) => a !== null && a.track === b.track && a.start === b.start;
    for (const deck of decks) if (deck.slot && !wanted.some((slot) => same(deck.slot, slot))) release(deck);
    for (const slot of wanted) {
      if (decks.some((deck) => same(deck.slot, slot))) continue;
      const deck = decks.find((d) => !d.slot);
      if (!deck) break;
      deck.slot = slot;
      deck.element.src = trackUrl(slot.track);
      deck.element.preload = 'auto';
    }

    let newest: Slot | null = null;
    for (const deck of decks) {
      const slot = deck.slot;
      if (!slot) continue;
      const into = time - slot.start;
      deck.level.gain.setTargetAtTime(slotLevel(slot, time), at, 0.1);
      if (into < 0 || deck.broken) continue;
      if (!newest || slot.start > newest.start) newest = slot;
      const { element } = deck;
      // Back in step after a pause, or after drifting while it played (not while it is still loading).
      const drifted = element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !element.seeking && Math.abs(element.currentTime - into) > DRIFT_S;
      if (element.paused || drifted) element.currentTime = into;
      if (element.paused) {
        element.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'NotAllowedError') waitForGesture();
        });
      }
    }
    if (newest?.track !== current) {
      current = newest?.track ?? null;
      changed();
    }
  }

  function start(): void {
    if (!timer) timer = window.setInterval(tick, TICK_MS);
    if (!askedClock) {
      askedClock = true;
      void clockOffset().then((ms) => {
        offset = ms;
        tick();
      });
    }
    tick();
  }

  function stop(): void {
    window.clearInterval(timer);
    timer = 0;
  }

  /** Something changed: start the clock if the music should come up, or let the tick fade it out. */
  function update(): void {
    if (!supported) return;
    if (shouldPlay()) start();
    else if (timer) tick();
    else for (const deck of decks) deck.element.pause();
  }

  document.addEventListener('visibilitychange', update);

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
      if (!value) distance = Infinity;
      update();
    },
    setListener(x, y, z, hallRadius) {
      const was = shouldPlay();
      distance = distanceToSource(x, y, z);
      radius = hallRadius;
      // Every frame: only stepping into or out of earshot needs more than the next tick.
      if (shouldPlay() !== was) update();
    },
    setEnabled(value) {
      enabled = value;
      try {
        if (value) localStorage.removeItem(MUSIC_KEY);
        else localStorage.setItem(MUSIC_KEY, 'off');
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
      update();
      changed();
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

import type { Track } from './tracks';

/**
 * The lobby's playlist as a timetable everyone works out alike: the same clock
 * and the same track list give every visitor the same song at the same moment,
 * with no server keeping time. The tracks play in rounds, each round in its
 * own shuffled order, each song overlapping the next by a crossfade.
 */

/** Seconds two songs overlap while one fades out and the next fades in. */
export const FADE_S = 4;
/** When the timetable began. Any fixed moment works, as long as everyone uses the same one. */
export const EPOCH_MS = Date.UTC(2026, 0, 1);

export interface Slot {
  track: Track;
  /** Seconds since EPOCH_MS. */
  start: number;
  end: number;
}

/** A small seeded random generator (mulberry32), so every visitor shuffles alike. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(tracks: readonly Track[], round: number): Track[] {
  const random = seeded(round * 2654435761);
  const out = [...tracks];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One round's order, never opening with the song that closed the round before. */
export function roundOrder(tracks: readonly Track[], round: number): Track[] {
  const order = shuffle(tracks, round);
  if (order.length > 2 && order[0] === shuffle(tracks, round - 1).at(-1)) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

/** Seconds one round takes: every song, less the overlap into the next. */
export function roundLength(tracks: readonly Track[]): number {
  return tracks.reduce((sum, track) => sum + track.duration - FADE_S, 0);
}

/** Every song sounding at some point between `from` and `to` (seconds since EPOCH_MS), in order. */
export function slotsBetween(tracks: readonly Track[], from: number, to: number): Slot[] {
  const length = roundLength(tracks);
  if (tracks.length === 0 || length <= 0) return [];
  const slots: Slot[] = [];
  for (let round = Math.floor(from / length) - 1; round * length <= to; round++) {
    let start = round * length;
    for (const track of roundOrder(tracks, round)) {
      const end = start + track.duration;
      if (end > from && start <= to) slots.push({ track, start, end });
      start = end - FADE_S;
    }
  }
  return slots;
}

/** How loud a song is at `time`, 0–1: rising over its first FADE_S seconds, falling over its last. */
export function slotLevel(slot: Slot, time: number): number {
  const x = Math.min((time - slot.start) / FADE_S, (slot.end - time) / FADE_S, 1);
  // Equal-power, so the crossfade does not dip in the middle.
  return x <= 0 ? 0 : Math.sin((x * Math.PI) / 2);
}

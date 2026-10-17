import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRACKS, trackUrl } from '../src/music/tracks';

const musicDir = new URL('../public/music/', import.meta.url);

/** An Ogg Vorbis file's length: its last page's sample position over its sample rate. */
function oggSeconds(file: URL): number {
  const bytes = readFileSync(file);
  const header = bytes.indexOf('\x01vorbis', 0, 'latin1');
  const rate = bytes.readUInt32LE(header + 12);
  const last = bytes.lastIndexOf('OggS', undefined, 'latin1');
  return Number(bytes.readBigInt64LE(last + 6)) / rate;
}

describe('music tracks', () => {
  it.each(TRACKS.map((track) => [track.title, track] as const))('%s has its file, source and licence', (_, track) => {
    expect(existsSync(new URL(track.file, musicDir))).toBe(true);
    expect(track.source).toMatch(/^https:\/\//);
    expect(track.license.url).toMatch(/^https:\/\//);
    expect(track.artist.trim()).not.toBe('');
    // Everyone's timetable is worked out from these, so they must match the file.
    expect(Math.abs(oggSeconds(new URL(track.file, musicDir)) - track.duration)).toBeLessThan(0.15);
  });

  it('gives every attribution licence its credit line', () => {
    for (const track of TRACKS.filter((t) => t.license.attribution)) expect(track.attribution, track.title).toBeTruthy();
  });

  it('serves file names with spaces as valid URLs', () => {
    for (const track of TRACKS) expect(trackUrl(track)).not.toMatch(/\s/);
  });

  it('lists each file once', () => {
    expect(new Set(TRACKS.map((t) => t.file)).size).toBe(TRACKS.length);
  });
});

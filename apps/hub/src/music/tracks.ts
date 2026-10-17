/**
 * Every song the lobby plays, and everything its credit needs. This is the
 * one place to add a song: drop its file in public/music/ unchanged, add an
 * entry here (with its length; the tests check it against the file), and
 * both the lobby playlist and /music-credits pick it up.
 *
 * Checked against each source page on 2026-10-17. Several OpenGameArt pieces
 * are offered under more than one licence; `license` is the one WorldMesh
 * uses them under.
 */

export interface License {
  /** Short name, as the licence itself gives it. */
  name: string;
  /** The licence's own page. */
  url: string;
  /** True when the licence requires crediting the author (CC BY and the like). */
  attribution: boolean;
}

export const LICENSES = {
  cc0: {
    name: 'CC0 1.0',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: false,
  },
  ccBy4: {
    name: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: true,
  },
} satisfies Record<string, License>;

export interface Track {
  /** The title as its source page gives it. */
  title: string;
  /** Who made it, as its source page credits them. */
  artist: string;
  /** File name in public/music/, exactly as downloaded. */
  file: string;
  /** Length in seconds. Everyone's lobby works out the same playlist from these. */
  duration: number;
  /** The page the song was taken from. */
  source: string;
  license: License;
  /** The credit line the author asks for, word for word, when they give one. */
  attribution?: string;
  /** What WorldMesh changed from the source file, if anything (CC BY asks for this). */
  changes?: string;
}

export const TRACKS: Track[] = [
  {
    title: 'Springtechno',
    artist: 'Spring Spring',
    file: 'springtechno wip_Master.ogg',
    duration: 534.0,
    source: 'https://opengameart.org/content/springtechno',
    license: LICENSES.cc0,
    attribution: 'Spring/Flofflewoffle Flooferwoofer',
  },
  {
    title: 'Funky Hip Hop Lofi Jam (Lowpass)',
    artist: 'omfgdude',
    file: 'CVP701Jam-Lowpass.ogg',
    duration: 189.3,
    source: 'https://opengameart.org/content/funky-hip-hop-lofi-jam',
    license: LICENSES.cc0,
  },
  {
    title: 'Up in the Sky',
    artist: "Memoraphile @ You're Perfect Studio",
    file: 'Memoraphile - Up in the Sky.ogg',
    duration: 197.6,
    source: 'https://opengameart.org/content/up-in-the-sky',
    license: LICENSES.cc0,
  },
  {
    title: 'I Do Know',
    artist: "Memoraphile @ You're Perfect Studio",
    file: 'I_Do_Know_by_Memoraphile_CC0.ogg',
    duration: 156.0,
    source: 'https://opengameart.org/content/i-do-know',
    license: LICENSES.cc0,
  },
  {
    title: 'Calm Ambient 3 (Lifewave 2k)',
    artist: 'The Cynic Project',
    file: '006_lifeWave2k.ogg',
    duration: 187.3,
    source: 'https://opengameart.org/content/calm-ambient-3-lifewave-2k',
    license: LICENSES.cc0,
    attribution: 'The Cynic Project / cynicmusic.com / pixelsphere.org',
    changes: 'Converted from MP3 to Ogg Vorbis.',
  },
  {
    title: 'Good Morning',
    artist: "Cakeflaps @ You're Perfect Studio",
    file: 'Cakeflaps - Good Morning.ogg',
    duration: 121.1,
    source: 'https://opengameart.org/content/good-morning',
    license: LICENSES.cc0,
    attribution: "Good Morning by Cakeflaps @ You're Perfect Studio",
  },
  {
    title: 'Bossa Shop Theme (HD)',
    artist: 'SpringySpringo',
    file: 'springyspringo_-_bossa_hd.ogg',
    duration: 87.2,
    source: 'https://opengameart.org/content/bossa-shop-theme-in-low-fi-and-hd',
    license: LICENSES.cc0,
    changes: 'Converted from MP3 to Ogg Vorbis.',
  },
  {
    title: 'Local Forecast - Elevator',
    artist: 'Kevin MacLeod',
    file: 'Local-Forecast-Elevator.ogg',
    duration: 189.2,
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1300012',
    license: LICENSES.ccBy4,
    attribution: '"Local Forecast - Elevator" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/',
    changes: 'Converted from MP3 to Ogg Vorbis.',
  },
];

/** Where a track is served from. */
export function trackUrl(track: Track): string {
  return `/music/${encodeURIComponent(track.file)}`;
}

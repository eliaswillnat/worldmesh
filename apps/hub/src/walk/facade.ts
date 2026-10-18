/**
 * Storefront façades for the city's blocks, as plain numbers: how one wall,
 * corner to corner, divides into bays. Each world's door gets a storefront
 * bay of its own, centred on it, between two piers and under a fascia sign.
 * The wall left over becomes blank bays of about the same proportions, each
 * with a recessed panel; a sliver too narrow for a bay widens the pier
 * instead. Square piers stand at the block's corners, and one beam runs the
 * whole wall over every bay. avenues.ts turns this into geometry.
 *
 * Nothing here knows whether the wall is straight or curved: everything is
 * measured along it, so the same layout lines the city's straight streets
 * and bends round the hall.
 */

import { DOOR_HALF_SPAN, DOOR_TOP } from './door';

/** Width of a pier between two bays. */
export const PIER_WIDTH = 0.8;
/** How far the piers stand out from the wall. */
export const PIER_DEPTH = 0.45;
/** The square pier at each corner of a block: it covers this much of each wall. */
export const CORNER_HALF = 0.8;
/** Clear wall between a door's frame and the piers either side of it. */
const DOOR_MARGIN = 0.6;
/** Half a storefront bay, pier centre to door centre. */
export const STOREFRONT_HALF = DOOR_HALF_SPAN + DOOR_MARGIN + PIER_WIDTH / 2;
/** A storefront bay, pier centre to pier centre: what each door takes along the wall. */
export const STOREFRONT_WIDTH = STOREFRONT_HALF * 2;
/** Blank bays come out about half a storefront wide, so the rhythm stays the same along every wall. */
const BLANK_TARGET = STOREFRONT_HALF;
/** Wall narrower than this between two bays is not a bay: the pier widens to fill it. */
const MIN_BLANK = 3;

/** The fascia sign over a door: bottom and top, and how far it stands out. */
export const FASCIA_BOTTOM = DOOR_TOP + 0.5;
export const FASCIA_TOP = FASCIA_BOTTOM + 2.1;
export const FASCIA_DEPTH = 0.35;
/** The beam across the whole wall, resting on the piers. */
export const BEAM_BOTTOM = FASCIA_TOP + 0.3;
export const BEAM_TOP = BEAM_BOTTOM + 0.55;
export const BEAM_DEPTH = 0.55;
/** A blank bay's recessed panel: how far in from its piers, its bottom and top, and its raised surround. */
export const PANEL_INSET = 0.45;
export const PANEL_BOTTOM = 0.9;
export const PANEL_TOP = FASCIA_TOP - 0.25;
export const PANEL_RIM = 0.22;
export const PANEL_DEPTH = 0.1;
/** Heights of a façade's parts: the fascia sign, the beam over it, and the blank bays' panels. */
export interface FacadeLevels {
  fasciaBottom: number;
  fasciaTop: number;
  beamBottom: number;
  beamTop: number;
  panelBottom: number;
  panelTop: number;
}

/** Out on the streets, under the blocks' cornice. */
export const STREET_LEVELS: FacadeLevels = {
  fasciaBottom: FASCIA_BOTTOM,
  fasciaTop: FASCIA_TOP,
  beamBottom: BEAM_BOTTOM,
  beamTop: BEAM_TOP,
  panelBottom: PANEL_BOTTOM,
  panelTop: PANEL_TOP,
};

/**
 * The same parts fitted under a ceiling, such as the rotunda's band of
 * screens: the beam just under it, the fascia as tall as is left over the doors.
 */
export function levelsUnder(ceiling: number): FacadeLevels {
  const beamTop = ceiling - 0.15;
  const beamBottom = beamTop - 0.5;
  const fasciaTop = beamBottom - 0.15;
  return {
    fasciaBottom: Math.min(FASCIA_BOTTOM, DOOR_TOP + 0.4),
    fasciaTop,
    beamBottom,
    beamTop,
    panelBottom: PANEL_BOTTOM,
    panelTop: fasciaTop - 0.25,
  };
}

/** Blank bays narrower than this keep a plain wall, without a panel. */
const PANEL_MIN = PANEL_INSET * 2 + PANEL_RIM * 2 + 1;

/** A stretch of wall, from `start` to `end` metres along it. */
export interface Span {
  start: number;
  end: number;
}

export interface Storefront extends Span {
  /** Index of the door, in the order the doors were given. */
  door: number;
  /** The fascia sign: between the piers' inner faces. */
  sign: Span;
}

export interface FacadeLayout {
  /** Solid piers, including the stretch each corner pier covers along this wall. */
  piers: Span[];
  storefronts: Storefront[];
  /** Blank bays between piers; `panel` is false where one is too narrow for a recessed panel. */
  blanks: Array<Span & { panel: boolean }>;
}

/**
 * Lay out a wall `length` metres long, with doors centred at `doors` metres
 * along it (in any order, never closer than a storefront apart).
 */
export function planFacade(length: number, doors: number[]): FacadeLayout {
  const order = doors.map((at, door) => ({ at, door })).sort((a, b) => a.at - b.at);
  const storefronts: Storefront[] = order.map(({ at, door }) => ({
    door,
    start: at - STOREFRONT_HALF,
    end: at + STOREFRONT_HALF,
    sign: { start: at - STOREFRONT_HALF + PIER_WIDTH / 2, end: at + STOREFRONT_HALF - PIER_WIDTH / 2 },
  }));
  const piers: Span[] = [];
  const blanks: FacadeLayout['blanks'] = [];
  const half = PIER_WIDTH / 2;

  // Walk the wall from corner to corner. A pier is open from `pierFrom`
  // and solid up to `edge`; it closes where a bay begins.
  let pierFrom = 0;
  let edge = CORNER_HALF;
  /** Wall up to `start` is left before the next pier, which spans to `end`: fill it, or let the pier run on. */
  const reach = (start: number, end: number) => {
    const gap = start - edge;
    if (gap < MIN_BLANK) {
      // Too narrow for a bay: the pier runs on across it.
      edge = end;
      return;
    }
    piers.push({ start: pierFrom, end: edge });
    // Blank bays fill the gap evenly, with a pier between each two.
    const count = Math.max(1, Math.round(gap / BLANK_TARGET));
    const width = (gap - (count - 1) * PIER_WIDTH) / count;
    for (let i = 0; i < count; i++) {
      const from = edge + i * (width + PIER_WIDTH);
      blanks.push({ start: from, end: from + width, panel: width >= PANEL_MIN });
      if (i < count - 1) piers.push({ start: from + width, end: from + width + PIER_WIDTH });
    }
    pierFrom = start;
    edge = end;
  };
  for (const front of storefronts) {
    // The pier on its left closes at the doorway's side; a new one opens on its right.
    reach(front.start - half, front.start + half);
    piers.push({ start: pierFrom, end: edge });
    pierFrom = front.end - half;
    edge = front.end + half;
  }
  reach(length - CORNER_HALF, length);
  piers.push({ start: pierFrom, end: length });
  return { piers, storefronts, blanks };
}

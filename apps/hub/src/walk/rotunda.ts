import {
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { flipInside } from './city';
import { loadCoverTexture } from './door';

/**
 * The hall as a hub rotunda, like the atrium of a station, airport or mall:
 * a glass dome with an oculus the spawn beam rises through, galleries of
 * doors ringing the drum below the screens, a departures board
 * hanging over the middle, and concourse signs at the exits. Only looks: none of it is solid.
 */

/** Height of the drum, where the dome springs from. */
export const DRUM_HEIGHT = 36;
/** The dome rises this fraction of the hall's radius above the drum. */
const DOME_RISE = 0.36;
/** Open eye at the crown, wide enough for the spawn beam's halo. */
export const OCULUS_RADIUS = 2.6;
/** Meridian ribs round the dome. */
const DOME_RIBS = 24;
/** Rings of the dome's lattice between the drum and the oculus. */
const DOME_RINGS = 4;

/** The screen band above the galleries never gets taller than this. */
export const MEDIA_MAX_HEIGHT = 7.4;
/**
 * Gallery floors (balcony tops), bottom to top. Each storey is as tall as the
 * hall's, so the gallery doors are full size, with room for their names.
 */
export const GALLERY_LEVELS = [10.4, 19.4];
/** How far each gallery reaches into the hall: the first is roomy, for the escalators' landings. */
const GALLERY_DEPTHS = [6, 4];
const SLAB = 0.45;
const RAIL = 1.1;
/** Headroom on the top gallery, under the screen band. */
const TOP_HEADROOM = 7.6;
/** Where the screen band starts: just over the top gallery's doors. */
export const MEDIA_BOTTOM = GALLERY_LEVELS[GALLERY_LEVELS.length - 1] + TOP_HEADROOM + 1.2;

/** The departures halo: an outer ring of covers and a smaller one of listings below it. */
const BOARD_HEIGHT = 5.2;
/** Portrait (3:4) covers round the outer ring, and the radius that fits them exactly. */
const BOARD_TILES = 16;
const BOARD_RADIUS = (BOARD_TILES * BOARD_HEIGHT * 0.75) / (Math.PI * 2);
const TILE_PX = 512;
export const BOARD_BOTTOM = 13.4;
/** Turns per second of the screens, in radians. */
const BOARD_SPIN = 0.08;
/** With more worlds than tiles, one tile moves on to the next world this often, in seconds. */
const BOARD_SWAP_S = 4;
/** Seconds a cover takes to dissolve into the next one. */
const BOARD_FADE_S = 1.6;
const AMBER = '#ffc23d';


const matrix = new Matrix4();
const up = new Vector3(0, 1, 0);

/** Flatten an indexed geometry so it merges with the non-indexed ones. */
function flat(geometry: BufferGeometry): BufferGeometry {
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

/** A thin rod from `a` to `b`. */
export function rod(a: Vector3, b: Vector3, radius: number): BufferGeometry {
  const length = a.distanceTo(b);
  const geometry = new CylinderGeometry(radius, radius, length, 6, 1, true);
  const direction = b.clone().sub(a).normalize();
  const middle = a.clone().add(b).multiplyScalar(0.5);
  geometry.applyMatrix4(matrix.compose(middle, new Quaternion().setFromUnitVectors(up, direction), new Vector3(1, 1, 1)));
  return flat(geometry);
}

export interface DomeShape {
  /** Sphere the dome is cut from. */
  sphereRadius: number;
  centerY: number;
  /** Polar angles (from straight up) of the oculus rim and the drum. */
  thetaTop: number;
  thetaBase: number;
  /** Height of the oculus rim. */
  oculusY: number;
}

export function domeShape(radius: number): DomeShape {
  const rise = radius * DOME_RISE;
  const sphereRadius = (radius * radius + rise * rise) / (2 * rise);
  const centerY = DRUM_HEIGHT + rise - sphereRadius;
  const thetaTop = Math.asin(OCULUS_RADIUS / sphereRadius);
  const thetaBase = Math.asin(radius / sphereRadius);
  return { sphereRadius, centerY, thetaTop, thetaBase, oculusY: centerY + sphereRadius * Math.cos(thetaTop) };
}

/**
 * The glass dome over a hall of `radius`: the glazing, plus ribs (solid) and
 * light lines (glow) to merge into the citadel's trim.
 */
export function buildDome(radius: number): { glass: BufferGeometry; solid: BufferGeometry[]; glow: BufferGeometry[] } {
  const { sphereRadius: R, centerY, thetaTop, thetaBase } = domeShape(radius);
  const glass = new SphereGeometry(R, 96, 24, 0, Math.PI * 2, thetaTop, thetaBase - thetaTop);
  glass.translate(0, centerY, 0);
  const solid: BufferGeometry[] = [];
  const glow: BufferGeometry[] = [];
  const at = (r: number, theta: number, phi: number) =>
    new Vector3(r * Math.sin(theta) * Math.sin(phi), centerY + r * Math.cos(theta), r * Math.sin(theta) * Math.cos(phi));

  for (let i = 0; i < DOME_RIBS; i++) {
    const phi = (i / DOME_RIBS) * Math.PI * 2;
    const points = (r: number) =>
      Array.from({ length: 13 }, (_, j) => at(r, thetaTop + ((thetaBase - thetaTop) * j) / 12, phi));
    solid.push(flat(new TubeGeometry(new CatmullRomCurve3(points(R - 0.12)), 24, 0.13, 5, false)));
    glow.push(flat(new TubeGeometry(new CatmullRomCurve3(points(R - 0.27)), 24, 0.025, 4, false)));
  }
  // Rings of the lattice, a stout one round the oculus, and one on the drum.
  for (let j = 1; j <= DOME_RINGS; j++) {
    const theta = thetaTop + ((thetaBase - thetaTop) * j) / (DOME_RINGS + 1);
    const ring = new TorusGeometry(R * Math.sin(theta) - 0.1, 0.1, 5, 128);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, centerY + (R - 0.1) * Math.cos(theta), 0);
    solid.push(flat(ring));
  }
  const oculusY = centerY + R * Math.cos(thetaTop);
  const eye = new TorusGeometry(OCULUS_RADIUS, 0.28, 8, 96);
  eye.rotateX(Math.PI / 2);
  eye.translate(0, oculusY - 0.1, 0);
  solid.push(flat(eye));
  const eyeGlow = new TorusGeometry(OCULUS_RADIUS - 0.3, 0.035, 6, 96);
  eyeGlow.rotateX(Math.PI / 2);
  eyeGlow.translate(0, oculusY - 0.32, 0);
  glow.push(flat(eyeGlow));
  const foot = new TorusGeometry(radius - 0.15, 0.22, 6, 160);
  foot.rotateX(Math.PI / 2);
  foot.translate(0, DRUM_HEIGHT + 0.1, 0);
  solid.push(flat(foot));
  return { glass, solid, glow };
}

/**
 * Galleries round the drum above the screens: a glass balcony with a
 * frameless glass balustrade at each level. Doors line the wall behind (lobby.ts).
 */
export function buildGalleries(
  radius: number,
  /** Openings in each level's rail, where an escalator or bridge meets it. */
  gaps: RailGap[][] = [],
): {
  solid: BufferGeometry[];
  glow: BufferGeometry[];
  glass: BufferGeometry[];
  /** The see-through floors of the balconies. */
  decks: BufferGeometry[];
  /** Walkable decks and the rails round their edges, for the colliders. */
  colliders: BufferGeometry[];
} {
  const solid: BufferGeometry[] = [];
  const glow: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const decks: BufferGeometry[] = [];
  const colliders: BufferGeometry[] = [];

  GALLERY_LEVELS.forEach((level, index) => {
    const edge = galleryEdge(radius, index);
    // Slab, all glass: the edge facing the hall, the deck and its underside.
    const fascia = new CylinderGeometry(edge, edge, SLAB, 160, 1, true);
    fascia.translate(0, level - SLAB / 2, 0);
    decks.push(flat(flipInside(fascia)));
    const deck = new RingGeometry(edge, radius, 160, 1);
    deck.rotateX(-Math.PI / 2);
    deck.translate(0, level, 0);
    colliders.push(deck.clone());
    decks.push(flat(deck));
    const under = new RingGeometry(edge, radius, 160, 1);
    under.rotateX(Math.PI / 2);
    under.translate(0, level - SLAB, 0);
    // Solid too, so a camera following someone underneath stops below the slab.
    colliders.push(under.clone());
    decks.push(flat(under));
    // A frameless glass balustrade, open wherever something meets the gallery.
    const railR = edge + 0.08;
    for (const [start, length] of railArcs(gaps[index] ?? [])) {
      const segments = Math.max(2, Math.ceil(length * 30));
      const pane = new CylinderGeometry(railR, railR, RAIL, segments, 1, true, start, length);
      pane.translate(0, level + RAIL / 2, 0);
      colliders.push(pane.clone());
      // The same glass as the deck, so the panes read as a balustrade.
      decks.push(flat(pane));
    }
  });
  return { solid, glow, glass, decks, colliders };
}

/** An opening in a gallery rail: centred on `angle`, `half` radians either side. */
export interface RailGap {
  angle: number;
  half: number;
}

/** Inner edge of a gallery (0 is the lowest): where its rail runs. */
export function galleryEdge(radius: number, level: number): number {
  return radius - GALLERY_DEPTHS[level];
}

/** The stretches of rail between the gaps, as [start, length] angles. */
function railArcs(gaps: RailGap[]): Array<[number, number]> {
  if (!gaps.length) return [[0, Math.PI * 2]];
  const turn = Math.PI * 2;
  const sorted = gaps
    .map((gap) => ({ from: (((gap.angle - gap.half) % turn) + turn) % turn, length: gap.half * 2 }))
    .sort((a, b) => a.from - b.from);
  return sorted.map((gap, i) => {
    const next = sorted[(i + 1) % sorted.length];
    const start = gap.from + gap.length;
    const end = next.from + (i + 1 === sorted.length ? turn : 0);
    return [start, end - start] as [number, number];
  });
}

export interface Flight {
  name: string;
  gate: number;
  cover?: string;
  color?: string;
}

/** Node colours along the board's timeline when a world has none of its own. */
const TIMELINE = ['#3da9ff', '#5be06b', '#ffc23d', '#b45cff', '#ff4fa3'];

/**
 * The departures halo hanging over the middle of the hall: a ring of world
 * covers, each with its gate, turning slowly. The chrome rims and the
 * cables stay put.
 */
export function createDepartureBoard(): {
  group: Group;
  /** Points on the board's top, for hanging it from the dome. */
  hangers: Vector3[];
  setFlights(flights: Flight[]): void;
  setTheme(light: boolean): void;
  update(dt: number): void;
  dispose(): void;
} {
  const group = new Group();
  group.name = 'departures';
  const chrome = new MeshStandardMaterial({ roughness: 0.3, metalness: 0.35, side: DoubleSide });
  // White lines of light on the rims, like the rest of the hall's (ink by day).
  const edgeLight = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const geometries: BufferGeometry[] = [];
  const spinning = new Group();
  group.add(spinning);

  const screen = (width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 4;
    return { canvas, texture, material: new MeshBasicMaterial({ map: texture, toneMapped: false }) };
  };
  const outer = screen(BOARD_TILES * TILE_PX, Math.round((TILE_PX * 4) / 3));
  // What the ring showed before the last change, at half size: the covers dissolve
  // from it into the new ones instead of cutting.
  const before = screen(outer.canvas.width / 2, Math.round(outer.canvas.height / 2));
  const fade = {
    prevMap: { value: before.texture },
    uFade: { value: 1 },
    // The stretch of the texture (0..1 round the ring) that is changing.
    uSwapFrom: { value: 0 },
    uSwapTo: { value: 1 },
  };
  outer.material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fade);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D prevMap;\nuniform float uFade;\nuniform float uSwapFrom;\nuniform float uSwapTo;')
      .replace(
        '#include <map_fragment>',
        `vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        float changing = step( uSwapFrom, vMapUv.x ) * step( vMapUv.x, uSwapTo );
        float t = smoothstep( 0.0, 1.0, uFade );
        sampledDiffuseColor = mix( texture2D( prevMap, vMapUv ), sampledDiffuseColor, mix( 1.0, t, changing ) );
        diffuseColor *= sampledDiffuseColor;`,
      );
  };

  const drum = (radius: number, height: number, bottom: number, material: MeshBasicMaterial | MeshStandardMaterial, parent: Group) => {
    const geometry = new CylinderGeometry(radius, radius, height, 160, 1, true);
    geometry.translate(0, bottom + height / 2, 0);
    geometries.push(geometry);
    parent.add(new Mesh(geometry, material));
  };
  const ring = (radius: number, y: number, tube: number, material: MeshBasicMaterial | MeshStandardMaterial) => {
    const geometry = new TorusGeometry(radius, tube, 8, 192);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, y, 0);
    geometries.push(geometry);
    group.add(new Mesh(geometry, material));
  };
  const deck = (from: number, to: number, y: number, facing: number) => {
    const geometry = new RingGeometry(from, to, 160, 1);
    geometry.rotateX(facing);
    geometry.translate(0, y, 0);
    geometries.push(geometry);
    group.add(new Mesh(geometry, chrome));
  };

  const outerTop = BOARD_BOTTOM + BOARD_HEIGHT;
  // The screens, and a chrome drum just inside each so the back is not see-through.
  drum(BOARD_RADIUS, BOARD_HEIGHT, BOARD_BOTTOM, outer.material, spinning);
  drum(BOARD_RADIUS - 0.2, BOARD_HEIGHT + 0.6, BOARD_BOTTOM - 0.3, chrome, group);
  // The same covers on the inside, facing in, for anyone looking up through the ring.
  {
    const geometry = flipInside(new CylinderGeometry(BOARD_RADIUS - 0.25, BOARD_RADIUS - 0.25, BOARD_HEIGHT, 160, 1, true));
    // Mirror the texture so the covers and gates read the right way round from inside.
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    geometry.translate(0, BOARD_BOTTOM + BOARD_HEIGHT / 2, 0);
    geometries.push(geometry);
    spinning.add(new Mesh(geometry, outer.material));
  }
  // Chrome rims, a wide flange between the rings, and lines of light on every edge.
  ring(BOARD_RADIUS + 0.1, outerTop + 0.2, 0.22, chrome);
  ring(BOARD_RADIUS + 0.1, BOARD_BOTTOM - 0.25, 0.22, chrome);
  deck(BOARD_RADIUS - 0.2, BOARD_RADIUS + 0.3, outerTop + 0.3, -Math.PI / 2);
  deck(BOARD_RADIUS - 1.2, BOARD_RADIUS + 0.4, BOARD_BOTTOM - 0.45, Math.PI / 2);
  ring(BOARD_RADIUS + 0.38, BOARD_BOTTOM - 0.45, 0.03, edgeLight);
  ring(BOARD_RADIUS + 0.34, outerTop + 0.2, 0.025, edgeLight);

  const hangers = Array.from({ length: 6 }, (_, i) => {
    const angle = ((i + 0.5) / 6) * Math.PI * 2;
    return new Vector3(Math.sin(angle) * (BOARD_RADIUS - 0.2), outerTop + 0.4, Math.cos(angle) * (BOARD_RADIUS - 0.2));
  });

  let flights: Flight[] = [];
  const covers = new Map<string, CanvasImageSource>();
  let disposed = false;
  /**
   * The world on each tile. Fewer worlds than BOARD_TILES repeat a whole number
   * of times round the ring, so it turns without a seam; more are fed in one
   * tile at a time, continuing the list.
   */
  let tiles: number[] = [];
  /** The next world to feed in, and the tile it replaces. */
  let upcoming = 0;
  let swapAt = 0;
  let sinceSwap = 0;

  const colorOf = (flight: Flight, index: number) => flight.color ?? TIMELINE[index % TIMELINE.length];
  const font = (weight: number, size: number) => `${weight} ${size}px Urbanist, ui-sans-serif, system-ui, sans-serif`;
  const ellipsize = (ctx: CanvasRenderingContext2D, text: string, width: number) => {
    if (ctx.measureText(text).width <= width) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  };

  /** One cover and its gate, on tile `t` of the ring. */
  const drawTile = (ctx: CanvasRenderingContext2D, t: number) => {
    const H = outer.canvas.height;
    const W = outer.canvas.width / tiles.length;
    const x = t * W;
    const index = tiles[t];
    const flight = flights[index];
    const color = colorOf(flight, index);
    const image = flight.cover ? covers.get(flight.cover) : undefined;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, W, H);
    ctx.clip();
    ctx.fillStyle = '#05070d';
    ctx.fillRect(x, 0, W, H);
    ctx.beginPath();
    ctx.rect(x + 3, 0, W - 6, H);
    ctx.clip();
    if (image) {
      // Covers are 3:4 like the tiles; anything else is cropped, never stretched.
      const { width, height } = image as { width: number; height: number };
      const scale = Math.max(W / width, H / height);
      ctx.drawImage(image, x + (W - width * scale) / 2, (H - height * scale) / 2, width * scale, height * scale);
    } else {
      const fill = ctx.createLinearGradient(x, 0, x + W, H);
      fill.addColorStop(0, color);
      fill.addColorStop(1, '#0b0f1c');
      ctx.fillStyle = fill;
      ctx.fillRect(x, 0, W, H);
      ctx.font = font(700, 44);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ellipsize(ctx, flight.name, W - 60), x + W / 2, H / 2);
    }
    // The gate, as a small glowing badge at the foot of the cover.
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = 'rgba(5, 7, 13, 0.82)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(x + W / 2 - 84, H - 92, 168, 62, 31);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(700, 34);
    ctx.fillText(`GATE ${flight.gate}`, x + W / 2, H - 60);
    ctx.restore();
  };

  /**
   * Start a dissolve over [from, to] of the ring: keep what is showing now, so
   * the redrawn covers fade in over it. A change during a dissolve carries on from where it is.
   */
  const beginFade = (from: number, to: number) => {
    if (fade.uFade.value < 1) {
      fade.uSwapFrom.value = Math.min(fade.uSwapFrom.value, from);
      fade.uSwapTo.value = Math.max(fade.uSwapTo.value, to);
      return;
    }
    const ctx = before.canvas.getContext('2d')!;
    ctx.drawImage(outer.canvas, 0, 0, before.canvas.width, before.canvas.height);
    before.texture.needsUpdate = true;
    fade.uSwapFrom.value = from;
    fade.uSwapTo.value = to;
    fade.uFade.value = 0;
  };

  /** Portrait covers edge to edge round the whole ring, each with its gate. */
  const drawOuter = () => {
    const { canvas, texture } = outer;
    beginFade(0, 1);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let t = 0; t < tiles.length; t++) drawTile(ctx, t);
    texture.needsUpdate = true;
  };

  /** Lay the worlds round the ring afresh. */
  const layTiles = () => {
    const n = flights.length;
    if (!n) {
      tiles = [];
    } else if (n > BOARD_TILES) {
      tiles = Array.from({ length: BOARD_TILES }, (_, t) => t);
    } else {
      // A whole number of rounds of the list, as near BOARD_TILES as it comes,
      // so the last tile runs straight into the first. Tiles widen or narrow a little.
      const rounds = Math.max(1, Math.round(BOARD_TILES / n));
      tiles = Array.from({ length: n * rounds }, (_, t) => t % n);
    }
    upcoming = n > BOARD_TILES ? BOARD_TILES : 0;
    swapAt = 0;
    sinceSwap = 0;
  };

  const loadCovers = () => {
    for (const flight of flights) {
      const src = flight.cover;
      if (!src || covers.has(src)) continue;
      void loadCoverTexture(src).then((texture) => {
        if (!texture || disposed) return;
        covers.set(src, texture.image as CanvasImageSource);
        drawOuter();
      });
    }
  };

  return {
    group,
    hangers,
    setFlights(next) {
      const same =
        next.length === flights.length &&
        next.every((f, i) => f.name === flights[i].name && f.gate === flights[i].gate && f.cover === flights[i].cover);
      if (same) return;
      flights = next;
      layTiles();
      drawOuter();
      loadCovers();
    },
    setTheme(light) {
      edgeLight.color.set(light ? 0x3a3d44 : 0xffffff);
      // The same dark as the hall's walls by night; white like them by day.
      chrome.color.set(light ? 0xe6e9ef : 0x141418);
      chrome.emissive.set(light ? 0x6b707c : 0x000000);
    },
    update(dt) {
      spinning.rotation.y += dt * BOARD_SPIN;
      if (fade.uFade.value < 1) fade.uFade.value = Math.min(1, fade.uFade.value + dt / BOARD_FADE_S);
      if (flights.length <= BOARD_TILES) return;
      sinceSwap += dt;
      if (sinceSwap < BOARD_SWAP_S) return;
      sinceSwap = 0;
      // The oldest tile takes the next world, so the list keeps flowing round.
      tiles[swapAt] = upcoming;
      upcoming = (upcoming + 1) % flights.length;
      beginFade(swapAt / tiles.length, (swapAt + 1) / tiles.length);
      drawTile(outer.canvas.getContext('2d')!, swapAt);
      outer.texture.needsUpdate = true;
      swapAt = (swapAt + 1) % tiles.length;
    },
    dispose() {
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      for (const { texture, material } of [outer, before]) {
        texture.dispose();
        material.dispose();
      }
      chrome.dispose();
      edgeLight.dispose();
      group.removeFromParent();
    },
  };
}

/** A canvas-backed plane that owns its material, redrawn for each theme. */
export interface Painted {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  draw(light: boolean): void;
}

function painted(width: number, height: number, canvasW: number, canvasH: number, paint: (ctx: CanvasRenderingContext2D, light: boolean) => void): Painted {
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  return {
    mesh,
    draw(light) {
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvasW, canvasH);
      paint(ctx, light);
      texture.needsUpdate = true;
    },
  };
}

/** Wayfinding over a sealed exit: the concourse letter and what is (not yet) there. */
export function createConcourseSign(letter: string): Painted {
  return painted(5, 1.25, 1024, 256, (ctx) => {
    // Signs stay dark with amber letters in either theme, like the board.
    ctx.fillStyle = '#0d0d10';
    ctx.beginPath();
    ctx.roundRect(4, 4, 1016, 248, 28);
    ctx.fill();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.roundRect(32, 32, 192, 192, 20);
    ctx.fill();
    ctx.fillStyle = '#0d0d10';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 150px Urbanist, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(letter, 128, 136);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 92px Urbanist, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`Concourse ${letter}`, 268, 104);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '600 44px Urbanist, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('Opening soon', 270, 186);
  });
}

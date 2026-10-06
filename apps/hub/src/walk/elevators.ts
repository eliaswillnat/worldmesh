import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flipInside } from './city';
import { GALLERY_LEVELS, galleryEdge, type RailGap } from './rotunda';

/**
 * Glass lifts up the rotunda's galleries, like the scenic lifts in an atrium.
 * Each stands in a round glass shaft just in front of the first gallery and
 * stops at the hall floor, the first gallery (step straight across) and the
 * second (across a small square landing). Call it from its door and it comes
 * to you; inside, E takes it up a floor and Q down, or pick one from the buttons.
 *
 * The cabs are shared: everyone in the room sees the same cab at the same
 * floor. Each client runs the same motion; only the choices (where a cab is
 * going, and from where) travel, through `onSend` and `applyShared`. A call
 * while someone else is riding waits until they step out.
 */

/** Exits (quarter turns from A) the lifts stand in front of. */
const LIFT_EXITS = [1, 3];
/** Inside radius of the cab. */
const CAB = 1.7;
const CAB_HEIGHT = 3;
/** The open side of the cab (and the shaft), either side of facing the wall. */
const OPEN_HALF = (52 * Math.PI) / 180;
/** Keep this far inside the cab's glass. */
const INSIDE = CAB - 0.35;
/** Stand this close to a closed shaft and you are kept out. */
const OUTSIDE = CAB + 0.4;
/** Stand this close to the door on your floor to be offered the call button. */
const CALL_REACH = 3;
/**
 * Someone else standing in a cab holds a call this long, then it goes ahead
 * and takes them along, so nobody can park in a lift and keep it.
 */
const HOLD_S = 8;
/** A shared state further than this from where a cab is here moves it there. */
const DRIFT = 0.75;
const MAX_SPEED = 4.5;
const ACCEL = 4;
const RAIL = 1.1;
/**
 * The cab's floor stands this far above each floor it stops at, so it never
 * lies in the same plane as the hall's floor or a gallery deck and flickers.
 */
const FLOOR_LIFT = 0.05;
const DECK = 0.35;

/** Heights the lifts stop at: the hall floor, then each gallery. */
const FLOORS = [0, ...GALLERY_LEVELS];
export const FLOOR_NAMES = ['Ground', 'First', 'Second'];

interface Lift {
  /** Centre of the shaft. */
  x: number;
  z: number;
  /** Unit vector toward the wall: the side the cab opens on. */
  outX: number;
  outZ: number;
  /** Where the cab's floor is now, and where it is heading. */
  y: number;
  velocity: number;
  target: number;
  /** The moving parts: floor (solid), glass, roof and trim. */
  cab: Group;
  floor: Mesh;
  /** The glass door on the hall side, open only while the cab stands at the hall floor. */
  door: Mesh;
  /** A call from this visitor waiting for the cab to be free, or null. */
  queued: number | null;
  /** Seconds someone else has stood in the standing cab. */
  held: number;
}

/** A lift's shared state: where it is heading (`f`), from where (`y`) and how fast (`v`). */
export interface LiftShared {
  f: number;
  y: number;
  v: number;
}

/** Where a call stands, for the prompt at a lift's door. */
export interface LiftCall {
  index: number;
  /** The floor the caller stands on. */
  floor: number;
  /** 'idle': not called yet. 'coming': on its way. 'waiting': someone else is in it. */
  state: 'idle' | 'coming' | 'waiting';
}

interface Body {
  x: number;
  y: number;
  z: number;
}

/** A point `r` out along `angle`, `side` metres to its side, at height `y`. */
function at(angle: number, r: number, side: number, y: number): Vector3 {
  return new Vector3(Math.sin(angle) * r + Math.cos(angle) * side, y, Math.cos(angle) * r - Math.sin(angle) * side);
}

/** Where the lifts stand for a hall of `radius`, and the gallery rail openings they need. */
export function planLifts(radius: number): { centres: Array<{ angle: number; r: number }>; gaps: RailGap[][] } {
  const first = galleryEdge(radius, 0);
  const second = galleryEdge(radius, 1);
  const centres: Array<{ angle: number; r: number }> = [];
  const gaps: RailGap[][] = [[], []];
  for (const exit of LIFT_EXITS) {
    const angle = (exit * Math.PI) / 2;
    // The cab's open side just meets the first gallery's edge.
    const r = first - CAB + 0.05;
    centres.push({ angle, r });
    gaps[0].push({ angle, half: (CAB * Math.sin(OPEN_HALF) + 0.1) / first });
    gaps[1].push({ angle, half: (CAB + 0.3) / second });
  }
  return { centres, gaps };
}

/**
 * The fixed parts: glass shafts with lit rails, and at the second gallery a
 * square landing out to each shaft, with rails, lined up with the gallery.
 */
export function buildShafts(plan: ReturnType<typeof planLifts>, radius: number): {
  solid: BufferGeometry[];
  glass: BufferGeometry[];
  glow: BufferGeometry[];
  colliders: BufferGeometry[];
} {
  const solid: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const glow: BufferGeometry[] = [];
  const colliders: BufferGeometry[] = [];
  const matrix = new Matrix4();
  const flat = (geometry: BufferGeometry) => (geometry.index ? geometry.toNonIndexed() : geometry);
  const top = FLOORS[FLOORS.length - 1] + CAB_HEIGHT + 0.6;
  const second = galleryEdge(radius, 1);
  const level = FLOORS[2];

  for (const { angle, r } of plan.centres) {
    const centre = at(angle, r, 0, 0);
    // Shaft: glass round the sides. The back, facing the wall, is open all
    // the way up for the galleries; the front, facing the hall, only at the
    // bottom, where you walk in from the hall floor.
    // Cylinder angles start at +Z and turn toward +X, like the hall's.
    const open0 = angle - OPEN_HALF;
    const shaftR = CAB + 0.12;
    const doorway = CAB_HEIGHT + 0.3;
    const side = Math.PI - OPEN_HALF * 2;
    for (const start of [angle + OPEN_HALF, angle + Math.PI + OPEN_HALF]) {
      const sides = flipInside(new CylinderGeometry(shaftR, shaftR, top, 48, 1, true, start, side));
      sides.translate(centre.x, top / 2, centre.z);
      glass.push(flat(sides));
    }
    const above = flipInside(new CylinderGeometry(shaftR, shaftR, top - doorway, 24, 1, true, angle + Math.PI - OPEN_HALF, OPEN_HALF * 2));
    above.translate(centre.x, doorway + (top - doorway) / 2, centre.z);
    glass.push(flat(above));
    // Lit guide rails up either side of both openings.
    for (const theta of [open0, open0 + OPEN_HALF * 2, angle + Math.PI - OPEN_HALF, angle + Math.PI + OPEN_HALF]) {
      const rail = new BoxGeometry(0.1, top, 0.1);
      rail.translate(centre.x + Math.sin(theta) * shaftR, top / 2, centre.z + Math.cos(theta) * shaftR);
      glow.push(flat(rail));
    }
    // A ring at every floor, and a cap over the top.
    for (const y of [...FLOORS, top]) {
      const ring = new TorusGeometry(shaftR, 0.08, 6, 48);
      ring.rotateX(Math.PI / 2);
      ring.translate(centre.x, y + 0.02, centre.z);
      solid.push(flat(ring));
    }
    const cap = new CylinderGeometry(shaftR + 0.15, shaftR + 0.15, 0.5, 48);
    cap.translate(centre.x, top + 0.25, centre.z);
    solid.push(flat(cap));

    // The second gallery's landing: square to the hall, from the shaft out to the gallery.
    const r0 = r + CAB * Math.cos(OPEN_HALF) - 0.1;
    const r1 = second + 0.4;
    const half = CAB + 0.3;
    const box = (a0: number, a1: number, s0: number, s1: number, y0: number, y1: number) => {
      const geometry = new BoxGeometry(Math.abs(s1 - s0), y1 - y0, Math.abs(a1 - a0));
      geometry.applyMatrix4(matrix.makeRotationY(angle).setPosition(at(angle, (a0 + a1) / 2, (s0 + s1) / 2, (y0 + y1) / 2)));
      return flat(geometry);
    };
    const deck = box(r0, r1, -half, half, level - DECK, level);
    solid.push(deck.clone());
    colliders.push(deck);
    for (const s of [-half, half - 0.04]) {
      const pane = box(r0, second, s, s + 0.04, level, level + RAIL);
      glass.push(pane.clone());
      colliders.push(pane);
      glow.push(box(r0, second, s - 0.02, s + 0.06, level + RAIL - 0.03, level + RAIL + 0.04));
    }
    glow.push(box(r0, r1, -half - 0.02, -half, level - DECK + 0.06, level - DECK + 0.12));
    glow.push(box(r0, r1, half, half + 0.02, level - DECK + 0.06, level - DECK + 0.12));
  }
  return { solid, glass, glow, colliders };
}

/**
 * The cabs, and what moves them: calls from whoever walks up to a door,
 * floor choices from whoever is inside, and keeping people in the cab (and
 * out of an empty shaft). Riders are carried on the cab's floor.
 */
export class Lifts {
  readonly group = new Group();
  private lifts: Lift[] = [];
  private glass: Material;
  private trim: MeshBasicMaterial;
  private body: Material;
  private floorMaterial: Material;
  private geometries: BufferGeometry[] = [];
  /** Shared states heard before the lifts were built, applied when they are. */
  private pending = new Map<number, LiftShared>();
  /** Told whenever this visitor sends a cab somewhere, to pass on to everyone else. */
  onSend: (index: number, state: LiftShared) => void = () => {};

  constructor(materials: { glass: Material; trim: MeshBasicMaterial; body: Material; floor: Material }) {
    this.glass = materials.glass;
    this.trim = materials.trim;
    this.body = materials.body;
    this.floorMaterial = materials.floor;
    this.group.name = 'lifts';
  }

  /** The cab floors: solid, so riders stand on them. */
  get colliders(): Mesh[] {
    return this.lifts.map((lift) => lift.floor);
  }

  setLifts(plan: ReturnType<typeof planLifts>): void {
    // A rebuilt hall keeps its cabs where they were.
    const before = this.lifts.map(({ y, velocity, target, queued }) => ({ y, velocity, target, queued }));
    this.clear();
    for (const { angle, r } of plan.centres) {
      const centre = at(angle, r, 0, 0);
      const cab = new Group();
      // Floor and roof discs, glass round the closed side, lit rims.
      const floorGeometry = new CylinderGeometry(CAB, CAB, 0.12, 48);
      floorGeometry.translate(0, FLOOR_LIFT - 0.06, 0);
      const floor = new Mesh(floorGeometry, this.floorMaterial);
      floor.matrixAutoUpdate = false;
      const roof = new CylinderGeometry(CAB, CAB, 0.14, 48);
      roof.translate(0, CAB_HEIGHT, 0);
      // Glass round the sides; open at the back (the galleries) and the front
      // (the hall floor), where a glass door closes except at the bottom.
      const side = Math.PI - OPEN_HALF * 2;
      const walls = [angle + OPEN_HALF, angle + Math.PI + OPEN_HALF].map((start) => {
        const arc = flipInside(new CylinderGeometry(CAB - 0.02, CAB - 0.02, CAB_HEIGHT, 24, 1, true, start, side));
        arc.translate(0, CAB_HEIGHT / 2, 0);
        return arc.index ? arc.toNonIndexed() : arc;
      });
      const wall = mergeGeometries(walls);
      const doorGeometry = flipInside(new CylinderGeometry(CAB - 0.04, CAB - 0.04, CAB_HEIGHT, 16, 1, true, angle + Math.PI - OPEN_HALF, OPEN_HALF * 2));
      doorGeometry.translate(0, CAB_HEIGHT / 2, 0);
      this.geometries.push(...walls, doorGeometry);
      const rims = [0.02, CAB_HEIGHT - 0.08].map((y) => {
        const rim = new TorusGeometry(CAB, 0.03, 6, 48);
        rim.rotateX(Math.PI / 2);
        rim.translate(0, y, 0);
        return rim;
      });
      // A handrail along each side. Laid flat, an arc runs the hall's way round
      // to π/2: turn it to span its stretch of glass.
      const handrails = [angle + OPEN_HALF, angle + Math.PI + OPEN_HALF].map((start) => {
        const rail = new TorusGeometry(CAB - 0.12, 0.03, 6, 24, side);
        rail.rotateX(Math.PI / 2);
        rail.rotateY(start + side - Math.PI / 2);
        rail.translate(0, 1, 0);
        return rail;
      });
      this.geometries.push(floorGeometry, roof, wall, ...rims, ...handrails);
      const roofMesh = new Mesh(roof, this.body);
      const glassMesh = new Mesh(wall, this.glass);
      glassMesh.renderOrder = 3;
      const door = new Mesh(doorGeometry, this.glass);
      door.renderOrder = 3;
      const trim = new Mesh(mergeGeometries([...rims, ...handrails].map((g) => (g.index ? g.toNonIndexed() : g))), this.trim);
      this.geometries.push(trim.geometry);
      cab.add(roofMesh, glassMesh, door, trim);
      this.group.add(cab, floor);
      this.lifts.push({
        x: centre.x,
        z: centre.z,
        outX: Math.sin(angle),
        outZ: Math.cos(angle),
        y: 0,
        velocity: 0,
        target: 0,
        cab,
        floor,
        door,
        queued: null,
        held: 0,
      });
      const index = this.lifts.length - 1;
      Object.assign(this.lifts[index], before[index]);
      const pending = this.pending.get(index);
      if (pending) this.applyShared(index, pending, 0);
    }
    this.pending.clear();
    this.place();
  }

  /**
   * Move the cabs, answer calls, and keep the visitor where they may be.
   * Returns where they should be (carried, or held back from glass), or null.
   */
  update(dt: number, position: Vector3, others: Iterable<Body> = []): Vector3 | null {
    let result: Vector3 | null = null;
    const bodies = [...others];
    for (let index = 0; index < this.lifts.length; index++) {
      const lift = this.lifts[index];
      const dx = position.x - lift.x;
      const dz = position.z - lift.z;
      const distance = Math.hypot(dx, dz);
      const aboard = distance < CAB && Math.abs(position.y - lift.y) < 0.6;
      const moving = isMoving(lift);

      // A waiting call goes once the cab stands empty (or has been kept long enough).
      const occupied = bodies.some((body) => this.inCab(lift, body));
      lift.held = !moving && occupied ? lift.held + dt : 0;
      if (lift.queued !== null) {
        if (lift.queued === lift.target && !moving) lift.queued = null;
        else if (!moving && (!occupied || lift.held >= HOLD_S)) {
          this.send(index, lift.queued);
          lift.queued = null;
        }
      }

      this.step(lift, dt);

      // Keep them inside the cab's glass, or outside an empty shaft. The open
      // side lets them through only while the cab stands at their floor.
      const facing = (dx * lift.outX + dz * lift.outZ) / Math.max(distance, 1e-6);
      const here = Math.abs(position.y - lift.y) < 0.6;
      const standing = here && Math.abs(lift.velocity) < 1e-3 && Math.abs(lift.y - FLOORS[lift.target]) < 1e-3;
      // The back opens onto the galleries; the front onto the hall floor only.
      const atBottom = lift.target === 0;
      const inOpening = facing > Math.cos(OPEN_HALF) || (atBottom && facing < -Math.cos(OPEN_HALF));
      let x = position.x;
      let z = position.z;
      if (aboard && distance > INSIDE && !(inOpening && standing)) {
        x = lift.x + (dx / distance) * INSIDE;
        z = lift.z + (dz / distance) * INSIDE;
      } else if (!aboard && distance < OUTSIDE && !(inOpening && standing) && position.y > -0.5 && position.y < FLOORS[FLOORS.length - 1] + 2) {
        const sx = distance > 1e-6 ? dx / distance : lift.outX;
        const sz = distance > 1e-6 ? dz / distance : lift.outZ;
        x = lift.x + sx * OUTSIDE;
        z = lift.z + sz * OUTSIDE;
      }
      if (aboard || x !== position.x || z !== position.z) {
        result = new Vector3(x, aboard ? lift.y + FLOOR_LIFT : position.y, z);
      }
    }
    this.place();
    return result;
  }

  /**
   * Draw someone else riding a cab on its floor. Their reported height trails
   * the cab by a network moment, which would sink them into a rising floor or
   * float them over a falling one.
   */
  ground(position: Vector3, grounded: boolean): void {
    for (const lift of this.lifts) {
      if (Math.hypot(position.x - lift.x, position.z - lift.z) >= CAB) continue;
      const floor = lift.y + FLOOR_LIFT;
      // Jumping in a standing cab still shows; in a moving one it is all riding.
      if (Math.abs(position.y - floor) < 1.5 && (grounded || isMoving(lift))) position.y = floor;
      return;
    }
  }

  /**
   * Near a lift's door on a floor where its cab is not standing: whether it
   * can be called, is on its way, or is waiting on someone else to get out.
   */
  callable(position: Vector3): LiftCall | null {
    for (let index = 0; index < this.lifts.length; index++) {
      const lift = this.lifts[index];
      const distance = Math.hypot(position.x - lift.x, position.z - lift.z);
      if (distance >= CALL_REACH || distance < CAB) continue;
      const floor = FLOORS.findIndex((y) => Math.abs(position.y - y) < 0.6);
      if (floor < 0) continue;
      const moving = isMoving(lift);
      if (lift.queued === floor) return { index, floor, state: 'waiting' };
      if (lift.target === floor) return moving ? { index, floor, state: 'coming' } : null;
      return { index, floor, state: 'idle' };
    }
    return null;
  }

  /**
   * Call a cab to a floor. It comes now if it is free; if it is moving or
   * someone else stands in it, the call waits its turn.
   */
  call(index: number, floor: number, others: Iterable<Body> = []): void {
    const lift = this.lifts[index];
    if (!lift || floor < 0 || floor >= FLOORS.length || lift.target === floor) return;
    const occupied = [...others].some((body) => this.inCab(lift, body));
    if (isMoving(lift) || occupied) lift.queued = floor;
    else this.send(index, floor);
  }

  /**
   * Someone (maybe this visitor, echoed back) sent a cab somewhere. Every
   * client takes the writes in the relay's order, so they agree on the last.
   * `age` is how long ago it happened, for state remembered from before joining.
   */
  applyShared(index: number, state: LiftShared, age: number): void {
    const target = Math.round(state.f);
    if (!(target >= 0 && target < FLOORS.length) || !Number.isFinite(state.y) || !Number.isFinite(state.v)) return;
    const lift = this.lifts[index];
    if (!lift) {
      this.pending.set(index, state);
      return;
    }
    lift.target = target;
    if (lift.queued === target) lift.queued = null;
    // Remembered state is replayed from where it started; a live write only
    // moves the cab when this client had it somewhere else.
    if (age > 0 || Math.abs(lift.y - state.y) > DRIFT) {
      lift.y = state.y;
      lift.velocity = state.v;
      // Catch up on the time since, a tick at a time; anything long has arrived.
      for (let t = Math.min(age, 30); t > 0; t -= 1 / 30) this.step(lift, Math.min(t, 1 / 30));
    }
    this.place();
  }

  /** The lift the visitor is standing in, if any, and which floor it is at or heading for. */
  aboard(position: Vector3): { index: number; floor: number; moving: boolean } | null {
    for (let index = 0; index < this.lifts.length; index++) {
      const lift = this.lifts[index];
      if (Math.hypot(position.x - lift.x, position.z - lift.z) < CAB && Math.abs(position.y - lift.y) < 0.6) {
        const moving = Math.abs(lift.y - FLOORS[lift.target]) > 1e-3;
        return { index, floor: lift.target, moving };
      }
    }
    return null;
  }

  /** Send a lift to a floor, and tell everyone else. */
  send(index: number, floor: number): void {
    const lift = this.lifts[index];
    if (!lift || floor < 0 || floor >= FLOORS.length) return;
    lift.target = floor;
    this.onSend(index, { f: floor, y: lift.y, v: lift.velocity });
  }

  /** Inside a standing cab: one floor up (+1) or down (-1). False when there is none that way. */
  move(position: Vector3, step: 1 | -1): boolean {
    const inside = this.aboard(position);
    if (!inside || inside.moving) return false;
    const floor = inside.floor + step;
    if (floor < 0 || floor >= FLOORS.length) return false;
    this.send(inside.index, floor);
    return true;
  }

  dispose(): void {
    this.clear();
  }

  /** Ease toward the target floor: speed up, cruise, slow to a stop. */
  private step(lift: Lift, dt: number): void {
    const goal = FLOORS[lift.target];
    const gap = goal - lift.y;
    if (Math.abs(gap) < 1e-3) {
      lift.y = goal;
      lift.velocity = 0;
      return;
    }
    const direction = Math.sign(gap);
    const brake = Math.sqrt(2 * ACCEL * Math.abs(gap));
    const wanted = direction * Math.min(MAX_SPEED, brake);
    const change = Math.max(-ACCEL * dt, Math.min(ACCEL * dt, wanted - lift.velocity));
    lift.velocity += change;
    const move = lift.velocity * dt;
    if (Math.abs(move) >= Math.abs(gap)) {
      lift.y = goal;
      lift.velocity = 0;
    } else lift.y += move;
  }

  private inCab(lift: Lift, body: Body): boolean {
    return Math.hypot(body.x - lift.x, body.z - lift.z) < CAB && Math.abs(body.y - lift.y) < 1.6;
  }

  private place(): void {
    for (const lift of this.lifts) {
      lift.cab.position.set(lift.x, lift.y, lift.z);
      lift.door.visible = !(lift.target === 0 && lift.y < 1e-3);
      lift.floor.matrix.makeTranslation(lift.x, lift.y, lift.z);
      lift.floor.matrixWorld.copy(lift.floor.matrix);
    }
  }

  private clear(): void {
    for (const lift of this.lifts) {
      lift.cab.removeFromParent();
      lift.floor.removeFromParent();
    }
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries = [];
    this.lifts = [];
  }
}

function isMoving(lift: Lift): boolean {
  return lift.velocity !== 0 || Math.abs(lift.y - FLOORS[lift.target]) > 1e-3;
}

/** Merge geometries into one mesh, disposing the parts. */
export function mergeInto(geometries: BufferGeometry[], material: Material): Mesh {
  const mesh = new Mesh(mergeGeometries(geometries), material);
  for (const geometry of geometries) geometry.dispose();
  return mesh;
}

/** An invisible, double-sided stand-in for the colliders. */
export function createColliderMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ side: DoubleSide, visible: false });
}

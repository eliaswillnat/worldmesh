import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { GALLERY_LEVELS } from '../src/walk/rotunda';
import { Lifts, planLifts, type LiftShared } from '../src/walk/elevators';

const RADIUS = 30;

function build(): { lifts: Lifts; sent: Array<[number, LiftShared]>; plan: ReturnType<typeof planLifts> } {
  const material = new MeshBasicMaterial();
  const lifts = new Lifts({ glass: material, trim: material, body: material, floor: material });
  const sent: Array<[number, LiftShared]> = [];
  lifts.onSend = (index, state) => sent.push([index, state]);
  const plan = planLifts(RADIUS);
  lifts.setLifts(plan);
  return { lifts, sent, plan };
}

/** Where to stand in front of lift 0's hall door, on `y`. */
function atDoor(plan: ReturnType<typeof planLifts>, y: number): Vector3 {
  const { angle, r } = plan.centres[0];
  const d = r - 2.3;
  return new Vector3(Math.sin(angle) * d, y, Math.cos(angle) * d);
}

function inCab(plan: ReturnType<typeof planLifts>, y: number): Vector3 {
  const { angle, r } = plan.centres[0];
  return new Vector3(Math.sin(angle) * r, y, Math.cos(angle) * r);
}

function run(lifts: Lifts, seconds: number, position: Vector3, others: Vector3[] = []): void {
  for (let t = 0; t < seconds; t += 1 / 60) lifts.update(1 / 60, position, others);
}

describe('shared lifts', () => {
  it('no longer comes on its own: the visitor calls it', () => {
    const { lifts, sent, plan } = build();
    lifts.applyShared(0, { f: 2, y: GALLERY_LEVELS[1], v: 0 }, 0);
    const here = atDoor(plan, 0);
    run(lifts, 5, here);
    expect(lifts.callable(here)).toEqual({ index: 0, floor: 0, state: 'idle' });
    expect(sent).toEqual([]);

    lifts.call(0, 0);
    expect(sent).toEqual([[0, { f: 0, y: GALLERY_LEVELS[1], v: 0 }]]);
    run(lifts, 0.5, here);
    expect(lifts.callable(here)?.state).toBe('coming');
    run(lifts, 10, here);
    expect(lifts.callable(here)).toBeNull();
  });

  it('follows someone else sending it, and draws their figure on its floor', () => {
    const { lifts, sent, plan } = build();
    lifts.applyShared(0, { f: 1, y: 0, v: 0 }, 0);
    run(lifts, 0.6, atDoor(plan, 0));
    // Their last report trails the rising cab.
    const rider = inCab(plan, 0.3);
    lifts.ground(rider, true);
    expect(rider.y).toBeGreaterThan(0.5);
    // Not pushed back out to the room: the client only follows.
    expect(sent).toEqual([]);
  });

  it('waits for someone riding to step out before answering a call', () => {
    const { lifts, sent, plan } = build();
    const here = atDoor(plan, GALLERY_LEVELS[1]);
    const rider = inCab(plan, 0.05);
    lifts.call(0, 2, [rider]);
    expect(lifts.callable(here)?.state).toBe('waiting');
    run(lifts, 2, here, [rider]);
    expect(sent).toEqual([]);
    run(lifts, 0.1, here, []);
    expect(sent.map(([, state]) => state.f)).toEqual([2]);
  });

  it('does not let someone park in it forever', () => {
    const { lifts, sent, plan } = build();
    const rider = inCab(plan, 0.05);
    lifts.call(0, 1, [rider]);
    run(lifts, 9, atDoor(plan, GALLERY_LEVELS[0]), [rider]);
    expect(sent.map(([, state]) => state.f)).toEqual([1]);
  });

  it('catches up on remembered state from before joining', () => {
    const { lifts, plan } = build();
    lifts.applyShared(0, { f: 2, y: 0, v: 0 }, 60);
    const rider = inCab(plan, GALLERY_LEVELS[1]);
    lifts.ground(rider, true);
    expect(rider.y).toBeCloseTo(GALLERY_LEVELS[1] + 0.05, 2);
  });

  it('keeps state heard before the hall was built', () => {
    const material = new MeshBasicMaterial();
    const lifts = new Lifts({ glass: material, trim: material, body: material, floor: material });
    lifts.applyShared(1, { f: 1, y: GALLERY_LEVELS[0], v: 0 }, 0);
    const plan = planLifts(RADIUS);
    lifts.setLifts(plan);
    const { angle, r } = plan.centres[1];
    expect(lifts.aboard(new Vector3(Math.sin(angle) * r, GALLERY_LEVELS[0] + 0.05, Math.cos(angle) * r))).toEqual({ index: 1, floor: 1, moving: false });
  });
});

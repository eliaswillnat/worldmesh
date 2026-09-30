import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/worlds/categories';
import { DEFAULT_CITY_CONFIG } from '../src/towers/config';
import cityData from '../src/towers/city.json';
import { planCity } from '../src/towers/plan';
import { DiscoveryElevator } from '../src/towers/elevator';
import { DoorRotationManager } from '../src/towers/rotationManager';
import { PlacementService } from '../src/discovery/service';
import { RankingService, NO_SIGNALS } from '../src/discovery/ranking';
import { RotationClock } from '../src/discovery/rotation';
import { MemoryWorldRepository } from '../src/worlds/repository';
import type { DoorView } from '../src/towers/doorView';
import type { WorldListing } from '../src/worlds/listing';
import type { Assignment } from '../src/discovery/placement';

const config = DEFAULT_CITY_CONFIG;
const plan = planCity(CATEGORIES, cityData, new Map(), config, 20);
const tower = plan.tower('explore')!;

/** Run the elevator for `seconds` in small steps, carrying (or not) a rider. */
function run(elevator: DiscoveryElevator, seconds: number, rider: boolean): number {
  let moved = 0;
  for (let t = 0; t < seconds; t += 1 / 30) moved += elevator.update(1 / 30, rider);
  return moved;
}

describe('discovery elevator', () => {
  it('waits where it was left until someone boards', () => {
    const elevator = new DiscoveryElevator(tower, config, { arrived: () => {} });
    expect(run(elevator, 20, false)).toBe(0);
    expect(elevator.isDockedAt(0)).toBe(true);
  });

  it('rises a floor at a time with a rider, pausing at each floor', () => {
    const arrived: number[] = [];
    const elevator = new DiscoveryElevator(tower, config, { arrived: (floor) => arrived.push(floor) });
    run(elevator, config.elevatorBoardDelayS + 0.1, true);
    expect(elevator.state).toBe('moving');
    while (!arrived.length) elevator.update(1 / 30, true);
    expect(arrived).toEqual([1]);
    expect(elevator.y).toBe(elevator.floorY(1));
    // It stays at floor 1 long enough to step off, then carries on up.
    expect(run(elevator, config.elevatorDwellS - 0.2, true)).toBe(0);
    run(elevator, 30, true);
    expect(arrived.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('never moves faster than its ride speed with a rider', () => {
    const elevator = new DiscoveryElevator(tower, config, { arrived: () => {} });
    let fastest = 0;
    for (let t = 0; t < 30; t += 1 / 60) fastest = Math.max(fastest, Math.abs(elevator.update(1 / 60, true)) * 60);
    expect(fastest).toBeLessThanOrEqual(config.elevatorSpeed + 1e-6);
  });

  it('comes when called, and ignores calls while someone rides', () => {
    const elevator = new DiscoveryElevator(tower, config, { arrived: () => {} });
    elevator.call(6);
    run(elevator, 20, false);
    expect(elevator.isDockedAt(6)).toBe(true);
    // Board and head up; a call from floor 2 must not take the rider there.
    run(elevator, config.elevatorBoardDelayS + 0.5, true);
    elevator.call(2);
    run(elevator, 10, true);
    expect(elevator.floor).toBeGreaterThan(6);
  });

  it('turns back at the top', () => {
    const elevator = new DiscoveryElevator(tower, config, { arrived: () => {} });
    elevator.call(tower.floorCount - 1);
    run(elevator, 60, false);
    expect(elevator.isDockedAt(tower.floorCount - 1)).toBe(true);
    run(elevator, config.elevatorBoardDelayS + 8, true);
    expect(elevator.floor).toBe(tower.floorCount - 2);
  });
});

describe('door rotation manager', () => {
  const listings = Array.from({ length: 40 }, (_, i) => ({
    id: `w${i}`,
    name: `World ${i}`,
    url: `https://example.com/${i}`,
    categories: ['explore'],
    addedAt: new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString(),
  }));

  function setup() {
    let now = Date.UTC(2026, 8, 30);
    const repository = new MemoryWorldRepository(CATEGORIES);
    repository.merge(listings);
    const clock = new RotationClock({ intervalMs: 60_000, epochMs: 0 }, () => now);
    const service = new PlacementService({ repository, ranking: new RankingService(), signals: NO_SIGNALS, clock, config: config.placement });
    service.setTowers(plan.towers.map((t) => ({ towerId: t.id, categoryId: t.category.id, slots: t.floors.flatMap((f) => f.slots) })));
    const manager = new DoorRotationManager(service, repository, config);
    return { manager, service, clock, advance: (ms: number) => (now += ms) };
  }

  /** Just enough of a door for the manager. */
  function fakeDoor(slotId: string, floor: number) {
    const door = {
      slotId,
      towerId: 'explore',
      floor,
      listing: null as WorldListing | null,
      assignment: null as Assignment | null,
      shutter: { state: 'open' },
      rotations: 0,
      showNow(listing: WorldListing | null, assignment: Assignment | null) {
        door.listing = listing;
        door.assignment = assignment;
      },
      rotateTo(listing: WorldListing | null, assignment: Assignment | null) {
        door.rotations++;
        door.listing = listing;
        door.assignment = assignment;
      },
      updateAssignment(assignment: Assignment) {
        door.assignment = assignment;
      },
    };
    return door;
  }

  const slots = tower.floors.slice(0, 8).flatMap((f) => f.slots);

  it('shows every door its slot at once, then rotates them when the window changes', () => {
    const { manager, advance } = setup();
    const doors = slots.map((slot) => fakeDoor(slot.id, slot.floor));
    for (const door of doors) manager.attach(door as unknown as DoorView);
    expect(doors.filter((d) => d.listing).length).toBeGreaterThan(0);
    const before = doors.map((d) => d.listing?.id);
    advance(60_000);
    for (let t = 0; t < 5; t += 0.1) manager.update(0.1, () => false);
    const after = doors.map((d) => d.listing?.id);
    expect(after).not.toEqual(before);
    expect(doors.some((d) => d.rotations > 0)).toBe(true);
  });

  it('never swaps a door someone is at', () => {
    const { manager, service, advance } = setup();
    const doors = slots.map((slot) => fakeDoor(slot.id, slot.floor));
    for (const door of doors) manager.attach(door as unknown as DoorView);
    const held = doors[0];
    const kept = held.listing?.id;
    advance(60_000 * 3);
    for (let t = 0; t < 10; t += 0.1) manager.update(0.1, (door) => door === (held as unknown as DoorView));
    expect(held.listing?.id).toBe(kept);
    expect(held.rotations).toBe(0);
    // Once they walk away it catches up with its slot.
    for (let t = 0; t < 2; t += 0.1) manager.update(0.1, () => false);
    const current = service.placement('explore', manager.currentWindow).get(held.slotId)?.listingId;
    expect(held.listing?.id).toBe(current);
    expect(manager.pending).toBe(0);
  });
});

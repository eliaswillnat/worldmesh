import type { PlacementService } from '../discovery/service';
import { unitHash } from '../discovery/random';
import type { WorldRepository } from '../worlds/repository';
import type { CityConfig } from './config';
import type { DoorView } from './doorView';

/**
 * Keeps loaded doors in step with placement. When the rotation window
 * changes (or the listings do), every door whose slot now holds a different
 * world gets a shutter cycle, staggered so the change ripples through the
 * tower instead of snapping. A door someone is standing at or looking at
 * waits until they move on: nobody loses the world they were about to enter.
 */
export class DoorRotationManager {
  private window: number;
  private doors = new Set<DoorView>();
  /** Doors that should check their slot again, with the time left before they may move. */
  private due = new Map<DoorView, number>();
  private revision = 0;
  private seenRevision = 0;

  constructor(
    private service: PlacementService,
    private repository: WorldRepository,
    private config: CityConfig,
  ) {
    this.window = service.clock.current();
  }

  get currentWindow(): number {
    return this.window;
  }

  /** A door streamed in: show its slot's world straight away. */
  attach(door: DoorView): void {
    this.doors.add(door);
    const { listing, assignment } = this.lookup(door);
    door.showNow(listing, assignment);
  }

  detach(door: DoorView): void {
    this.doors.delete(door);
    this.due.delete(door);
  }

  /** Placement inputs changed (new listings, new signals): re-check every door. */
  refresh(): void {
    this.service.invalidate();
    this.revision++;
  }

  /**
   * `held(door)` says whether a door must wait (someone is at it). Call
   * every frame.
   */
  update(dt: number, held: (door: DoorView) => boolean): void {
    const window = this.service.clock.current();
    if (window !== this.window || this.revision !== this.seenRevision) {
      this.window = window;
      this.seenRevision = this.revision;
      for (const door of this.doors) this.due.set(door, unitHash(door.slotId ?? '', window) * this.config.shutter.staggerS + (door.floor % 4) * 0.12);
    }
    for (const [door, wait] of this.due) {
      const left = wait - dt;
      if (left > 0) {
        this.due.set(door, left);
        continue;
      }
      if (held(door)) {
        this.due.set(door, 0.5);
        continue;
      }
      this.due.delete(door);
      const { listing, assignment } = this.lookup(door);
      if (listing?.id === door.listing?.id) {
        if (assignment) door.updateAssignment(assignment);
        continue;
      }
      door.rotateTo(listing, assignment, 0);
    }
  }

  /** How many doors are mid-rotation, for the debug overlay. */
  get pending(): number {
    let busy = this.due.size;
    for (const door of this.doors) if (door.shutter.state === 'closing' || door.shutter.state === 'opening') busy++;
    return busy;
  }

  private lookup(door: DoorView) {
    if (!door.towerId || !door.slotId) return { listing: null, assignment: null };
    const assignment = this.service.placement(door.towerId, this.window).get(door.slotId) ?? null;
    const listing = assignment ? this.repository.get(assignment.listingId) ?? null : null;
    return { listing, assignment: listing ? assignment : null };
  }
}

import {
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  type BufferGeometry,
} from 'three';
import { flipInside } from '../walk/city';
import type { CityConfig } from './config';
import { setLayer, type CityMaterials } from './materials';
import type { TowerPlan } from './plan';
import { SIGN_FONT } from './signage';

/**
 * The central discovery elevator: a wide round platform in each tower's
 * shaft. Spatial scrolling. It rises slowly with someone aboard, pausing at
 * every floor long enough to step off, and waits wherever it was left.
 * Anyone on a floor can call it. Nobody has to ride it.
 *
 * The motion logic is plain state (the platform's height is the truth); the
 * visuals and colliders follow it, and only exist while the tower is loaded.
 */

export type ElevatorState = 'docked' | 'moving';

export interface ElevatorEvents {
  /** The platform stopped at a floor. */
  arrived(floor: number): void;
}

export class DiscoveryElevator {
  state: ElevatorState = 'docked';
  /** Height of the platform's top surface. */
  y: number;
  /** Floor it is docked at, or heading to. */
  floor = 0;
  /** +1 up, -1 down, 0 hold. Only matters with a rider aboard. */
  direction: -1 | 0 | 1 = 0;
  /** Someone asked it to come to their floor. */
  called = false;
  private velocity = 0;
  private waited = 0;
  private riderAboard = false;
  private boarded = false;
  private speed: number;

  constructor(
    readonly tower: TowerPlan,
    private config: CityConfig,
    private events: ElevatorEvents,
  ) {
    this.y = this.floorY(0);
    this.speed = config.elevatorSpeed;
  }

  get topFloor(): number {
    return this.tower.floorCount - 1;
  }

  isDockedAt(floor: number): boolean {
    return this.state === 'docked' && this.floor === floor;
  }

  /** Bring the platform to `floor` quickly. Ignored while someone rides it. */
  call(floor: number): void {
    if (this.riderAboard || this.isDockedAt(floor)) return;
    this.moveTo(floor, this.config.elevatorCallSpeed);
    this.called = true;
  }

  /** Rider's choice: up, down, or hold at the next floor. */
  setDirection(direction: -1 | 0 | 1): void {
    this.direction = direction;
    if (this.state === 'docked' && direction !== 0) this.waited = Infinity;
    if (this.state === 'moving' && direction !== 0 && Math.sign(this.floorY(this.floor) - this.y) !== direction) {
      // Reverse: head for the nearest floor the other way.
      const next = direction > 0 ? Math.ceil(this.y / this.config.floorHeight) : Math.floor(this.y / this.config.floorHeight);
      this.moveTo(clampFloor(next, this.topFloor), this.config.elevatorSpeed);
    }
  }

  /**
   * Advance by `dt`. `rider` says whether the player stands on the platform.
   * Returns how far the platform moved, so the caller can carry the rider.
   */
  update(dt: number, rider: boolean): number {
    if (rider && !this.riderAboard) {
      this.boarded = true;
      this.waited = 0;
      if (this.direction === 0) this.direction = this.floor < this.topFloor ? 1 : -1;
    }
    if (!rider && this.riderAboard) this.direction = 0;
    this.riderAboard = rider;

    const before = this.y;
    if (this.state === 'docked') {
      this.waited += dt;
      const wait = this.boarded ? Math.max(this.config.elevatorBoardDelayS, 0) : this.config.elevatorDwellS;
      if (rider && this.direction !== 0 && this.waited >= wait) {
        const next = this.floor + this.direction;
        if (next < 0 || next > this.topFloor) this.direction = 0;
        else this.moveTo(next, this.config.elevatorSpeed);
      }
    } else {
      const target = this.floorY(this.floor);
      const remaining = target - this.y;
      const distance = Math.abs(remaining);
      // Accelerate gently, cruise, then ease into the floor.
      const accel = 1.1;
      const wanted = Math.min(this.speed, Math.sqrt(2 * accel * distance));
      this.velocity = Math.min(wanted, this.velocity + accel * dt);
      const step = Math.min(distance, this.velocity * dt);
      this.y += Math.sign(remaining) * step;
      if (distance - step < 0.002) {
        this.y = target;
        this.velocity = 0;
        this.state = 'docked';
        this.waited = 0;
        this.boarded = false;
        this.called = false;
        this.events.arrived(this.floor);
      }
    }
    return this.y - before;
  }

  floorY(floor: number): number {
    return floor === 0 ? 0.03 : floor * this.config.floorHeight;
  }

  private moveTo(floor: number, speed: number): void {
    this.floor = floor;
    this.speed = speed;
    this.state = 'moving';
    this.boarded = false;
  }
}

function clampFloor(floor: number, top: number): number {
  return Math.max(0, Math.min(top, floor));
}

/**
 * The platform's body: a thick disc with a lit rim, a railing that sinks
 * while docked, and a central column showing the floor it is at.
 */
export class ElevatorView {
  readonly group = new Group();
  /** What the player stands on. */
  readonly deck: Mesh;
  /** Keeps riders aboard between floors. Only in the collider list while moving. */
  readonly rail: Mesh;
  private railGlass: Mesh;
  private railTop: Mesh;
  private display: CanvasTexture;
  private displayCanvas = document.createElement('canvas');
  private shownFloor = -1;
  private geometries: BufferGeometry[] = [];
  private displayMaterial: MeshBasicMaterial;
  private railLift = 1;
  private floorHeight: number;

  constructor(
    private elevator: DiscoveryElevator,
    config: CityConfig,
    materials: CityMaterials,
    interiorLayer: number,
  ) {
    const r = config.platformRadius;
    this.floorHeight = config.floorHeight;
    const { center } = elevator.tower;
    const own = <T extends BufferGeometry>(geometry: T) => {
      this.geometries.push(geometry);
      return geometry;
    };

    const body = new Mesh(own(new CylinderGeometry(r, r * 0.97, 0.5, 72).translate(0, -0.25, 0)), materials.structure);
    const rim = new Mesh(own(new CylinderGeometry(r + 0.01, r + 0.01, 0.05, 72, 1, true).translate(0, -0.03, 0)), materials.accent(elevator.tower.category.color));
    const inlay = new Mesh(own(new CylinderGeometry(r * 0.62, r * 0.62, 0.02, 64, 1, true).translate(0, 0.01, 0)), materials.trim);
    this.railGlass = new Mesh(own(new CylinderGeometry(r - 0.12, r - 0.12, 1.0, 72, 1, true).translate(0, 0.5, 0)), materials.glass);
    this.railTop = new Mesh(own(new CylinderGeometry(r - 0.12, r - 0.12, 0.05, 72, 1, true).translate(0, 1.02, 0)), materials.trim);

    // The column: a slim pillar with the floor number on four faces.
    this.displayCanvas.width = 512;
    this.displayCanvas.height = 128;
    this.display = new CanvasTexture(this.displayCanvas);
    this.display.colorSpace = SRGBColorSpace;
    this.display.minFilter = LinearFilter;
    this.displayMaterial = new MeshBasicMaterial({ map: this.display, toneMapped: false });
    const column = new Mesh(own(new CylinderGeometry(0.28, 0.34, 1.25, 24).translate(0, 0.62, 0)), materials.frame);
    const screen = new Mesh(own(new CylinderGeometry(0.36, 0.36, 0.34, 32, 1, true).translate(0, 1.42, 0)), this.displayMaterial);

    this.group.add(body, rim, inlay, this.railGlass, this.railTop, column, screen);
    this.group.position.set(center.x, elevator.y, center.z);
    setLayer(this.group, interiorLayer);

    this.deck = new Mesh(own(new CircleGeometry(r, 48).rotateX(-Math.PI / 2)));
    this.deck.visible = false;
    this.rail = new Mesh(own(flipInside(new CylinderGeometry(r - 0.15, r - 0.15, 1.4, 48, 1, true)).translate(0, 0.7, 0)));
    this.rail.visible = false;
    this.sync(0);
  }

  /** Follow the elevator's state. Call every frame after it updates. */
  sync(dt: number): void {
    const { center } = this.elevator.tower;
    const y = this.elevator.y;
    this.group.position.y = y;
    this.group.updateMatrixWorld(true);
    for (const collider of [this.deck, this.rail]) {
      collider.position.set(center.x, y, center.z);
      collider.updateMatrixWorld(true);
    }
    // The railing rises while moving and sinks into the deck while docked.
    const target = this.elevator.state === 'moving' ? 1 : 0;
    this.railLift += (target - this.railLift) * (1 - Math.exp(-dt * 6));
    this.railGlass.scale.y = this.railTop.scale.y = 1;
    this.railGlass.position.y = this.railTop.position.y = (this.railLift - 1) * 1.05;
    this.railGlass.visible = this.railTop.visible = this.railLift > 0.02;

    const floor = this.elevator.state === 'docked' ? this.elevator.floor : Math.round(y / this.floorHeight);
    if (floor !== this.shownFloor) {
      this.shownFloor = floor;
      const ctx = this.displayCanvas.getContext('2d')!;
      ctx.fillStyle = '#101114';
      ctx.fillRect(0, 0, 512, 128);
      ctx.fillStyle = this.elevator.tower.category.color;
      ctx.font = `800 84px ${SIGN_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 4; i++) ctx.fillText(String(floor), 64 + i * 128, 66);
      this.display.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.display.dispose();
    this.displayMaterial.dispose();
    this.group.removeFromParent();
  }
}

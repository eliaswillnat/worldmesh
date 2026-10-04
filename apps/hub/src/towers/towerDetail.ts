import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  type BufferGeometry,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flipInside } from '../walk/city';
import { doorFrameGeometry } from '../walk/doorShape';
import type { CityConfig } from './config';
import type { DoorView } from './doorView';
import { setLayer, type CityMaterials } from './materials';
import type { FloorPlan, TowerPlan, WallPosition } from './plan';
import { drawBand, SIGN_FONT } from './signage';

/**
 * The inside of one tower, streamed in chunks of floors around the player.
 * Only the floors near them exist at all; everything above and below is the
 * shell's painted interior. Repeated parts (slabs, railings, door frames,
 * lift doors) are instanced, so a loaded tower costs a fixed handful of draw
 * calls plus one per visible door.
 */

export interface FloorView {
  plan: FloorPlan;
  doors: DoorView[];
  /** The floor's name band, hung at the edge of the shaft. */
  label: Mesh<BufferGeometry, MeshBasicMaterial>;
  labelTexture: Texture;
  colliders: { slab: Mesh; wall: Mesh; rail: Mesh };
  visible: boolean;
}

export interface DetailResources {
  config: CityConfig;
  materials: CityMaterials;
  interiorLayer: number;
  acquireDoor(): DoorView;
  releaseDoor(door: DoorView): void;
  /** A door streamed in: show whatever its slot holds now. */
  onDoorLoaded(door: DoorView): void;
  onDoorUnloaded(door: DoorView): void;
}

/** Shared geometry for every tower's details, built once per city. */
export class DetailGeometry {
  readonly slab: BufferGeometry;
  readonly railGlass: BufferGeometry;
  readonly railTop: BufferGeometry;
  readonly doorFrame: BufferGeometry;
  readonly liftDoor: BufferGeometry;
  readonly liftFrame: BufferGeometry;
  readonly doorPlane: PlaneGeometry;
  /** Colliders shared by every floor without openings. */
  readonly slabCollider: BufferGeometry;
  readonly railCollider: BufferGeometry;
  readonly fullWallCollider: BufferGeometry;
  private wallColliders = new Map<string, BufferGeometry>();

  constructor(private config: CityConfig) {
    const { towerRadius: r, shaftRadius: shaft, slabThickness: t, doorWidth } = config;
    const doorHeight = (doorWidth * 16) / 9;

    const top = new RingGeometry(shaft, r + 0.05, 96, 1).rotateX(-Math.PI / 2);
    const bottom = new RingGeometry(shaft, r + 0.05, 96, 1).rotateX(Math.PI / 2).translate(0, -t, 0);
    const edge = flipInside(new CylinderGeometry(shaft, shaft, t, 96, 1, true)).translate(0, -t / 2, 0);
    this.slab = mergeGeometries([top, bottom, edge].map((g) => g.toNonIndexed()));
    for (const g of [top, bottom, edge]) g.dispose();

    const railR = shaft + 0.28;
    this.railGlass = new CylinderGeometry(railR, railR, 1.05, 96, 1, true).translate(0, 0.525, 0);
    this.railTop = new CylinderGeometry(railR, railR, 0.06, 96, 1, true).translate(0, 1.08, 0);

    // A door frame: posts, lintel and the shutter housing over the opening.
    // The opening's top corners match the gallery cards.
    const frame = 0.16;
    const depth = 0.34;
    const sill = config.doorSill;
    this.doorFrame = doorFrameGeometry(doorWidth, doorHeight, frame, depth, sill, 0.42);

    const liftW = 2.6;
    const liftH = 3.6;
    this.liftDoor = new PlaneGeometry(liftW, liftH).translate(0, liftH / 2, 0.02);
    const liftParts = [
      new BoxGeometry(0.3, liftH + 0.3, 0.4).translate(-(liftW + 0.3) / 2, (liftH + 0.3) / 2, 0),
      new BoxGeometry(0.3, liftH + 0.3, 0.4).translate((liftW + 0.3) / 2, (liftH + 0.3) / 2, 0),
      new BoxGeometry(liftW + 0.6, 0.8, 0.4).translate(0, liftH + 0.4, 0),
    ];
    this.liftFrame = mergeGeometries(liftParts.map((g) => g.toNonIndexed()));
    for (const g of liftParts) g.dispose();

    this.doorPlane = new PlaneGeometry(doorWidth, doorHeight);

    this.slabCollider = new RingGeometry(Math.max(0.1, shaft - 0.05), r + 0.4, 48, 1).rotateX(-Math.PI / 2);
    this.railCollider = new CylinderGeometry(railR, railR, 1.3, 48, 1, true).translate(0, 0.65, 0);
    this.fullWallCollider = this.wallCollider([]);
  }

  /** The wall around one floor, facing in, with gaps where `gaps` open it. */
  wallCollider(gaps: readonly WallPosition[]): BufferGeometry {
    const key = gaps.map((gap) => `${gap.angle.toFixed(4)}/${gap.halfWidth.toFixed(4)}`).join('|');
    let geometry = this.wallColliders.get(key);
    if (geometry) return geometry;
    const { towerRadius: r, floorHeight: h } = this.config;
    const inner = r - 0.1;
    if (!gaps.length) {
      geometry = flipInside(new CylinderGeometry(inner, inner, h, 48, 1, true)).translate(0, h / 2, 0);
    } else {
      const sorted = [...gaps].sort((a, b) => a.angle - b.angle);
      const pieces: BufferGeometry[] = [];
      sorted.forEach((gap, i) => {
        const next = sorted[(i + 1) % sorted.length];
        const start = gap.angle + gap.halfWidth;
        let end = next.angle - next.halfWidth;
        if (i === sorted.length - 1 || end < start) end += Math.PI * 2;
        const length = end - start;
        if (length <= 0.001) return;
        const piece = flipInside(new CylinderGeometry(inner, inner, h, Math.max(2, Math.ceil(length * 12)), 1, true, start, length));
        pieces.push(piece.translate(0, h / 2, 0).toNonIndexed());
      });
      geometry = mergeGeometries(pieces);
      for (const piece of pieces) piece.dispose();
    }
    this.wallColliders.set(key, geometry);
    return geometry;
  }

  dispose(): void {
    for (const g of [this.slab, this.railGlass, this.railTop, this.doorFrame, this.liftDoor, this.liftFrame, this.doorPlane, this.slabCollider, this.railCollider]) g.dispose();
    for (const g of this.wallColliders.values()) g.dispose();
  }
}

export class TowerDetail {
  readonly group = new Group();
  readonly floors = new Map<number, FloorView>();
  private slabs: InstancedMesh;
  private railGlass: InstancedMesh;
  private railTop: InstancedMesh;
  private frames: InstancedMesh;
  private liftDoors: InstancedMesh;
  private liftFrames: InstancedMesh;
  private matrix = new Matrix4();
  private dirty = true;
  /** Floor whose railing is lowered (the platform is docked there), or null. */
  private openGate: number | null = null;

  constructor(
    readonly tower: TowerPlan,
    private geometry: DetailGeometry,
    private res: DetailResources,
    liftDoorMaterial: MeshBasicMaterial,
  ) {
    const { config, materials } = res;
    const maxFloors = (config.chunkRadius * 2 + 2) * config.floorsPerChunk + 2;
    const maxDoors = maxFloors * (Math.max(...Object.values(config.doorsPerFloor)) + 1);
    const maxLifts = maxFloors * Math.max(1, config.fastElevatorsPerTower);
    this.slabs = new InstancedMesh(geometry.slab, materials.structure, maxFloors);
    this.railGlass = new InstancedMesh(geometry.railGlass, materials.glass, maxFloors);
    this.railTop = new InstancedMesh(geometry.railTop, materials.trim, maxFloors);
    this.frames = new InstancedMesh(geometry.doorFrame, materials.frame, maxDoors);
    this.liftDoors = new InstancedMesh(geometry.liftDoor, liftDoorMaterial, maxLifts);
    this.liftFrames = new InstancedMesh(geometry.liftFrame, materials.frame, maxLifts);
    for (const mesh of [this.slabs, this.railGlass, this.railTop, this.frames, this.liftDoors, this.liftFrames]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.group.name = `detail:${tower.id}`;
    setLayer(this.group, res.interiorLayer);
  }

  /** Load exactly the floors in [from, to]; unload the rest. */
  setRange(from: number, to: number): { loaded: number[]; unloaded: number[] } {
    const lo = Math.max(0, from);
    const hi = Math.min(this.tower.floorCount - 1, to);
    const loaded: number[] = [];
    const unloaded: number[] = [];
    for (const index of [...this.floors.keys()]) {
      if (index < lo || index > hi) {
        this.unloadFloor(index);
        unloaded.push(index);
      }
    }
    for (let index = lo; index <= hi; index++) {
      if (!this.floors.has(index)) {
        this.loadFloor(index);
        loaded.push(index);
      }
    }
    if (loaded.length || unloaded.length) this.dirty = true;
    return { loaded, unloaded };
  }

  /** Only floors at the camera's height show their doors and signs: slabs hide the rest anyway. */
  setVisibleFloors(from: number, to: number): void {
    for (const floor of this.floors.values()) {
      const visible = floor.plan.index >= from && floor.plan.index <= to;
      if (visible === floor.visible) continue;
      floor.visible = visible;
      floor.label.visible = visible;
      for (const door of floor.doors) door.mesh.visible = visible;
    }
  }

  /** Lower the railing where the platform is docked, so people can step on and off. */
  setOpenGate(floor: number | null): void {
    if (floor === this.openGate) return;
    this.openGate = floor;
    this.dirty = true;
  }

  get gateFloor(): number | null {
    return this.openGate;
  }

  /** Rebuild instance transforms after floors changed. Cheap: a few dozen matrices. */
  sync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const { center } = this.tower;
    const { config } = this.res;
    let slabs = 0;
    let rails = 0;
    let frames = 0;
    let lifts = 0;
    const r = config.towerRadius - 0.12;
    for (const floor of this.floors.values()) {
      const y = floorSurface(floor.plan, config);
      this.slabs.setMatrixAt(slabs++, this.matrix.makeTranslation(center.x, y, center.z));
      // A retracted railing sinks into the floor.
      const railY = this.openGate === floor.plan.index ? y - 1.12 : y;
      this.matrix.makeTranslation(center.x, railY, center.z);
      this.railGlass.setMatrixAt(rails, this.matrix);
      this.railTop.setMatrixAt(rails++, this.matrix);
      for (const position of floor.plan.positions) {
        if (position.kind !== 'door' && position.kind !== 'lift') continue;
        const x = center.x + Math.sin(position.angle) * r;
        const z = center.z + Math.cos(position.angle) * r;
        this.matrix.makeRotationY(position.angle + Math.PI).setPosition(x, y, z);
        if (position.kind === 'door') this.frames.setMatrixAt(frames++, this.matrix);
        else {
          this.liftDoors.setMatrixAt(lifts, this.matrix);
          this.liftFrames.setMatrixAt(lifts++, this.matrix);
        }
      }
    }
    this.slabs.count = slabs;
    this.railGlass.count = this.railTop.count = rails;
    this.frames.count = frames;
    this.liftDoors.count = this.liftFrames.count = lifts;
    for (const mesh of [this.slabs, this.railGlass, this.railTop, this.frames, this.liftDoors, this.liftFrames]) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Colliders of the floors in [from, to]; the railing is left out where the gate is open. */
  colliders(from: number, to: number): Mesh[] {
    const list: Mesh[] = [];
    for (let index = from; index <= to; index++) {
      const floor = this.floors.get(index);
      if (!floor) continue;
      list.push(floor.colliders.slab, floor.colliders.wall);
      if (this.openGate !== index) list.push(floor.colliders.rail);
    }
    return list;
  }

  doors(): DoorView[] {
    const list: DoorView[] = [];
    for (const floor of this.floors.values()) list.push(...floor.doors);
    return list;
  }

  dispose(): void {
    for (const index of [...this.floors.keys()]) this.unloadFloor(index);
    for (const mesh of [this.slabs, this.railGlass, this.railTop, this.frames, this.liftDoors, this.liftFrames]) mesh.dispose();
    this.group.removeFromParent();
  }

  private loadFloor(index: number): void {
    const plan = this.tower.floors[index];
    const { config } = this.res;
    const { center } = this.tower;
    const y = floorSurface(plan, config);

    const doors: DoorView[] = [];
    for (const position of plan.positions) {
      if (position.kind !== 'door' || !position.slotId) continue;
      const door = this.res.acquireDoor();
      door.place(this.tower.id, position.slotId, index, position.angle, center, config.towerRadius - 0.14, y, this.tower.category.color);
      door.mesh.layers.set(this.res.interiorLayer);
      door.mesh.visible = false;
      this.group.add(door.mesh);
      doors.push(door);
      this.res.onDoorLoaded(door);
    }

    const labelTexture = drawBand(
      [
        { text: `${index}`, color: this.tower.category.color, font: `800 76px ${SIGN_FONT}` },
        { text: plan.title, color: '#f4f1ea', font: `600 44px ${SIGN_FONT}` },
      ],
      { width: 2048, height: 96, repeat: 4, gap: 28, background: '#141518', mirror: true },
    );
    const labelMaterial = new MeshBasicMaterial({ map: labelTexture, toneMapped: false });
    const labelHeight = 1.1;
    const labelRadius = config.shaftRadius - 0.03;
    const label = new Mesh(flipInside(new CylinderGeometry(labelRadius, labelRadius, labelHeight, 64, 1, true)), labelMaterial);
    label.position.set(center.x, y - labelHeight / 2, center.z);
    label.visible = false;
    label.layers.set(this.res.interiorLayer);
    this.group.add(label);

    const collider = (geometry: BufferGeometry) => {
      const mesh = new Mesh(geometry);
      mesh.visible = false;
      mesh.position.set(center.x, y, center.z);
      mesh.updateMatrixWorld(true);
      return mesh;
    };
    const gaps = plan.positions.filter((position) => position.kind === 'entrance' || position.kind === 'bridge');
    this.floors.set(index, {
      plan,
      doors,
      label,
      labelTexture,
      colliders: {
        slab: collider(this.geometry.slabCollider),
        wall: collider(gaps.length ? this.geometry.wallCollider(gaps) : this.geometry.fullWallCollider),
        rail: collider(this.geometry.railCollider),
      },
      visible: false,
    });
  }

  private unloadFloor(index: number): void {
    const floor = this.floors.get(index);
    if (!floor) return;
    for (const door of floor.doors) {
      this.res.onDoorUnloaded(door);
      this.res.releaseDoor(door);
    }
    floor.label.geometry.dispose();
    floor.label.material.dispose();
    floor.labelTexture.dispose();
    floor.label.removeFromParent();
    this.floors.delete(index);
  }
}

/** Height of a floor's walking surface. The ground floor sits a hair above the plaza mirror. */
export function floorSurface(plan: FloorPlan, config: CityConfig): number {
  return plan.index === 0 ? 0.03 : plan.index * config.floorHeight;
}

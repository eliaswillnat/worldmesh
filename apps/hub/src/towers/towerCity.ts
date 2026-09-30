import type { Vec3Tuple, WorldMeshHandle } from '@worldmesh/runtime';
import {
  CanvasTexture,
  CylinderGeometry,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  type PerspectiveCamera,
  type Scene,
  type Texture,
} from 'three';
import { Analytics, consoleSink } from '../analytics/analytics';
import { RankingService, NO_SIGNALS, type SignalSource } from '../discovery/ranking';
import { RotationClock } from '../discovery/rotation';
import { PlacementService } from '../discovery/service';
import { flipInside, type BillboardSlot } from '../walk/city';
import type { WalkSpot } from '../walk/lobby';
import { CATEGORIES, type CategoryRegistry } from '../worlds/categories';
import type { WorldListing, WorldRecordInput } from '../worlds/listing';
import { MemoryWorldRepository } from '../worlds/repository';
import { BridgeManager } from './bridges';
import { CardCache, createBadgeAtlas, createStatusAtlas } from './cards';
import cityData from './city.json';
import { resolveCityConfig, type CityConfig } from './config';
import { DoorView, type DoorResources } from './doorView';
import { DiscoveryElevator, ElevatorView } from './elevator';
import { CityHud, type LiftDestination, type LiftPanel, type SearchResultView } from './hud';
import { createCityMaterials, type CityMaterials } from './materials';
import { planCity, type BridgePlan, type CityData, type CityPlan, type TowerPlan, type WallPosition } from './plan';
import { DoorPreviewManager } from './previews';
import { DoorRotationManager } from './rotationManager';
import { createTowerShell, type TowerShell } from './shell';
import { SILENT_SHUTTERS } from './shutter';
import { DetailGeometry, TowerDetail, floorSurface } from './towerDetail';

/**
 * The tower city: the category towers around the citadel, their floors and
 * doors, the elevators and the bridges between them. The lobby owns the
 * scene, the player and travelling into worlds; this owns everything about
 * the city and tells the lobby when someone walks into a door.
 *
 * Each frame it works out where the player is, streams the floors around
 * them (and only those), keeps the collider list to what is near, moves the
 * elevators, keeps doors in step with the current rotation window, and picks
 * which doors animate or play their preview.
 */

export interface TowerCityOptions {
  scene: Scene;
  camera: PerspectiveCamera;
  container: HTMLElement;
  light: boolean;
  touch: boolean;
  /** Layer drawn by the main camera only (not the floor mirror). Interiors go here. */
  interiorLayer: number;
  signals?: SignalSource;
  analytics?: Analytics;
  config?: Partial<CityConfig>;
  categories?: CategoryRegistry;
  data?: CityData;
  /** Someone walked into (or picked) a world. The lobby takes it from here. */
  onEnterWorld(listing: WorldListing, returnTo: WalkSpot): void;
}

interface TowerState {
  plan: TowerPlan;
  shell: TowerShell;
  elevator: DiscoveryElevator;
  detail: TowerDetail | null;
  platform: ElevatorView | null;
}

interface Location {
  tower: TowerState | null;
  floor: number;
  bridge: { bridge: BridgePlan; t: number } | null;
}

interface Travel {
  towerId: string;
  from: number;
  to: number;
  spot: WalkSpot;
  time: number;
  duration: number;
  moved: boolean;
  highlight: string | null;
}

/** How long the screen stays covered before the jump, so the fade has finished. */
const TRAVEL_COVER_S = 0.3;
/** Seconds a door has to stay in view, close enough to read, to count as an impression. */
const IMPRESSION_S = 1;
const IMPRESSION_DISTANCE = 18;
/** Seconds on a floor before it counts as visited. */
const FLOOR_VISIT_S = 2;
/** A tap on a door this close enters it. */
const TAP_REACH = 7;
/** Stand this close to the shaft's railing to be offered the platform. */
const CALL_REACH = 1.8;
/** Stand this close in front of a lift to be offered it. */
const LIFT_REACH = 2.8;

export class TowerCity {
  readonly config: CityConfig;
  readonly repository: MemoryWorldRepository;
  readonly analytics: Analytics;
  readonly clock: RotationClock;
  readonly service: PlacementService;
  readonly rotation: DoorRotationManager;
  readonly previews: DoorPreviewManager;
  readonly group = new Group();
  plan: CityPlan | null = null;
  readonly towers = new Map<string, TowerState>();
  bridges: BridgeManager | null = null;

  private categories: CategoryRegistry;
  private data: CityData;
  private materials: CityMaterials;
  private geometry: DetailGeometry;
  private doorResources: DoorResources;
  private liftDoorMaterial: MeshBasicMaterial;
  private liftTexture: CanvasTexture;
  private blank: Texture;
  private pool: DoorView[] = [];
  private loaded = new Set<DoorView>();
  private loadedList: DoorView[] = [];
  private loadedDirty = false;
  private hud: CityHud;
  private world: WorldMeshHandle | null = null;
  private fence: Mesh | null = null;
  private active: Mesh[] = [];
  private planKey = '';
  private citadelOuter = 0;
  private light: boolean;
  private time = 0;
  private blocked = false;
  private location: Location = { tower: null, floor: 0, bridge: null };
  private rider: TowerState | null = null;
  private focus: DoorView | null = null;
  private focusKey = '';
  private nearLift: { tower: TowerState; position: WallPosition } | null = null;
  private nearCall: TowerState | null = null;
  private travel: Travel | null = null;
  private pendingHighlight: string | null = null;
  private impressions = new Map<DoorView, number>();
  private impressed = new Set<string>();
  private floorVisit = { key: '', time: 0, tracked: false };
  private bridgeSide = new Map<string, number>();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private debug: { update(dt: number): void; dispose(): void } | null = null;
  private disposed = false;

  constructor(private options: TowerCityOptions) {
    this.config = resolveCityConfig(options.config);
    this.categories = options.categories ?? CATEGORIES;
    this.data = options.data ?? (cityData as CityData);
    this.light = options.light;
    this.repository = new MemoryWorldRepository(this.categories);
    this.analytics = options.analytics ?? new Analytics();
    if (import.meta.env.DEV && !options.analytics) this.analytics.addSink(consoleSink);
    this.clock = new RotationClock({ intervalMs: this.config.rotationIntervalMs, epochMs: this.config.rotationEpochMs });
    this.service = new PlacementService({
      repository: this.repository,
      ranking: new RankingService(this.config.ranking),
      signals: options.signals ?? NO_SIGNALS,
      clock: this.clock,
      config: this.config.placement,
    });
    this.rotation = new DoorRotationManager(this.service, this.repository, this.config);
    this.previews = new DoorPreviewManager(this.config, this.analytics, options.touch);

    this.materials = createCityMaterials(options.light);
    this.geometry = new DetailGeometry(this.config);
    const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.blank = blank;
    this.doorResources = {
      geometry: this.geometry.doorPlane,
      badges: createBadgeAtlas(),
      status: createStatusAtlas(),
      blank,
      cards: new CardCache(this.config.maxCachedCards),
      config: this.config,
      audio: SILENT_SHUTTERS,
    };
    this.liftTexture = liftTexture();
    this.liftDoorMaterial = new MeshBasicMaterial({ map: this.liftTexture, toneMapped: false });

    this.group.name = 'tower-city';
    options.scene.add(this.group);
    this.raycaster.layers.enable(options.interiorLayer);

    this.hud = new CityHud(options.container, options.touch, {
      onPrompt: () => this.act('tap'),
      onRide: (direction) => this.ride(direction),
      onPanelClosed: () => {},
    });
    window.addEventListener('keydown', this.handleKey);
    this.applyTheme();

    if (import.meta.env.DEV) {
      Object.assign(window, { city: this });
      void import('./debug').then(({ CityDebug }) => {
        if (!this.disposed) this.debug = new CityDebug(this, options.container);
      });
    }
  }

  /** Where the walkable ground ends. */
  get groundRadius(): number {
    return this.plan?.groundRadius ?? 120;
  }

  /** Billboard slots for the ad system. The towers have none yet. */
  readonly billboards: readonly BillboardSlot[] = [];

  /** The mirror floor is only worth drawing from the plaza. */
  get wantsMirror(): boolean {
    return !this.location.tower && !this.location.bridge && this.options.camera.position.y < 14;
  }

  get currentLocation(): Readonly<Location> {
    return this.location;
  }

  get loadedDoors(): readonly DoorView[] {
    return this.doorList();
  }

  get focusedDoor(): DoorView | null {
    return this.focus;
  }

  attach(world: WorldMeshHandle): void {
    this.world = world;
  }

  /** Add listings (existing ones are kept). Rebuilds the city only if its shape changed. */
  setWorlds(records: readonly WorldRecordInput[]): void {
    const before = this.repository.version;
    this.repository.merge(records);
    if (this.repository.version === before) return;
    this.rotation.refresh();
    if (this.citadelOuter) this.layout(this.citadelOuter);
  }

  /** Debug: swap every listing for another set. */
  replaceWorlds(records: readonly WorldRecordInput[]): void {
    this.repository.replace(records);
    this.rotation.refresh();
    if (this.citadelOuter) this.layout(this.citadelOuter);
  }

  /** Stand the towers around a citadel whose outer wall has this radius. */
  layout(citadelOuter: number): void {
    this.citadelOuter = citadelOuter;
    const inventory = new Map(this.categories.list.map((category) => [category.id, this.repository.inCategory(category.id).length]));
    const plan = planCity(this.categories, this.data, inventory, this.config, citadelOuter);
    const key = `${plan.ringRadius}|${plan.towers.map((tower) => `${tower.id}:${tower.floorCount}`).join(',')}`;
    if (key === this.planKey) return;
    this.planKey = key;
    this.build(plan);
  }

  /** Colliders near the player. The lobby's collider list includes these. */
  colliders(): Mesh[] {
    return this.active;
  }

  /** Stop prompts and door entry (e.g. while travelling into a world). */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) {
      this.hud.setPrompt(null);
      this.hud.closePanel();
    }
  }

  setTheme(light: boolean): void {
    if (light === this.light) return;
    this.light = light;
    this.applyTheme();
  }

  /**
   * Stream in and collide with everything at `position` right now, before
   * the player is put there (arriving, coming back from a world, fast travel).
   */
  syncTo(position: Vec3Tuple): void {
    this.locate(position[0], position[1], position[2]);
    this.stream(position[1]);
    this.updateColliders(position);
  }

  /** Put the player somewhere, with the floor under them streamed in first. */
  teleport(position: Vec3Tuple, yaw: number): void {
    if (!this.world) return;
    this.syncTo(position);
    this.world.teleport(position, yaw);
    this.world.refreshColliders();
  }

  /** E, or the touch interact button. Returns false when there was nothing to do here. */
  interact(): boolean {
    return this.act('key');
  }

  /** A tap or click at a point on screen (normalised device coordinates). Returns true if it hit a door. */
  tap(ndcX: number, ndcY: number): boolean {
    if (this.blocked || this.travel || this.hud.panelOpen) return false;
    const doors = this.doorList().filter((door) => door.mesh.visible);
    if (!doors.length) return false;
    this.raycaster.setFromCamera(this.pointer.set(ndcX, ndcY), this.options.camera);
    this.raycaster.far = 60;
    const hit = this.raycaster.intersectObjects(doors.map((door) => door.mesh), false)[0];
    if (!hit) return false;
    const door = doors.find((candidate) => candidate.mesh === hit.object)!;
    const player = this.playerPosition();
    const distance = Math.hypot(door.center.x - player[0], door.center.z - player[2]);
    if (distance > TAP_REACH || !door.enterable) {
      // Too far to enter: light it up so they can find it.
      door.highlight = Math.max(door.highlight, 1.2);
      return true;
    }
    this.enterDoor(door, 'tap');
    return true;
  }

  /** Called every frame, after the player moved. */
  update(dt: number): void {
    if (!this.plan || !this.world) return;
    this.time += dt;
    const state = this.world.getState();
    let [x, y, z] = state.position;

    // Elevators first: the platform carries whoever stands on it.
    const riding = this.findRider(x, y, z, state.onGround);
    for (const tower of this.towers.values()) {
      const dy = tower.elevator.update(dt, tower === riding);
      if (tower === riding && dy !== 0 && !this.travel) {
        y += dy;
        this.world.setState({ position: [x, y, z] });
      }
    }
    if (riding !== this.rider) {
      if (riding) this.analytics.track('elevator_boarded', { towerId: riding.plan.id, kind: 'discovery', floor: riding.elevator.floor });
      this.rider = riding;
    }

    this.locate(x, y, z);
    this.stream(y);
    this.keepOffShaftEdge(x, y, z);
    this.updateColliders([x, y, z]);

    for (const tower of this.towers.values()) {
      tower.platform?.sync(dt);
      tower.detail?.sync();
    }

    this.updateFocus(x, y, z);
    this.rotation.update(dt, (door) => door === this.focus || (door.floor === this.location.floor && Math.hypot(door.center.x - x, door.center.z - z) < this.config.holdRadius));
    for (const door of this.doorList()) {
      if (this.pendingHighlight && door.slotId === this.pendingHighlight) {
        door.highlight = 4;
        this.pendingHighlight = null;
      }
      door.update(dt, this.time);
    }
    this.previews.update(dt, this.doorList(), this.options.camera);
    this.trackImpressions(dt, x, z);
    this.trackFloorVisit(dt);
    this.trackBridge();
    this.stepTravel(dt);
    this.updateHud();
    this.debug?.update(dt);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKey);
    this.debug?.dispose();
    this.hud.dispose();
    this.previews.dispose();
    this.teardown();
    for (const door of this.pool) door.dispose();
    this.pool = [];
    this.doorResources.cards.dispose();
    this.doorResources.badges.dispose();
    this.doorResources.status.dispose();
    this.blank.dispose();
    this.geometry.dispose();
    this.liftTexture.dispose();
    this.liftDoorMaterial.dispose();
    this.materials.dispose();
    this.group.removeFromParent();
  }

  // ── Fast travel ──────────────────────────────────────────────────────────

  /** Destinations for the fast lifts of a tower, lowest first. */
  destinations(tower: TowerPlan): LiftDestination[] {
    const here = this.location.tower?.plan === tower ? this.location.floor : -1;
    const list: LiftDestination[] = [{ label: 'Ground · Trending now', detail: 'Floor 0', towerId: tower.id, floor: 0 }];
    const rising = tower.floors.find((floor) => floor.band === 'middle');
    if (rising) list.push({ label: 'Rising', detail: `Floor ${rising.index}`, towerId: tower.id, floor: rising.index });
    for (const bridge of tower.bridges) {
      const other = this.categories.get(bridge.from === tower.id ? bridge.to : bridge.from);
      list.push({ label: `Bridge to ${other?.name ?? 'another tower'}`, detail: `Floor ${bridge.floor} · Transfer deck ${bridge.level}`, towerId: tower.id, floor: bridge.floor });
    }
    const gems = tower.floorCount - this.config.bands.summitFloors;
    if (gems > 0 && gems < tower.floorCount - 1) list.push({ label: 'Hidden gems', detail: `Floor ${gems}`, towerId: tower.id, floor: gems });
    list.push({ label: 'Summit · All-time', detail: `Floor ${tower.floorCount - 1}`, towerId: tower.id, floor: tower.floorCount - 1 });
    return list.sort((a, b) => a.floor - b.floor).map((entry) => ({ ...entry, current: entry.floor === here }));
  }

  /** Ride a fast lift (or jump from search) to a floor, landing at a lift or in front of a door. */
  travelTo(towerId: string, floor: number, target: { slotId?: string; liftIndex?: number } = {}): void {
    const tower = this.towers.get(towerId);
    if (!tower || !this.world || this.travel) return;
    const plan = tower.plan.floors[Math.max(0, Math.min(tower.plan.floorCount - 1, floor))];
    const y = floorSurface(plan, this.config);
    const { center } = tower.plan;
    const r = this.config.towerRadius;
    let spot: WalkSpot;
    const door = target.slotId ? plan.positions.find((position) => position.slotId === target.slotId) : undefined;
    if (door) {
      // A few steps back from the door, facing it.
      const d = r - 2.8;
      spot = { position: [center.x + Math.sin(door.angle) * d, y, center.z + Math.cos(door.angle) * d], yaw: door.angle + Math.PI };
    } else {
      const lifts = plan.positions.filter((position) => position.kind === 'lift');
      const lift = lifts.find((position) => position.liftIndex === target.liftIndex) ?? lifts[0];
      const angle = lift?.angle ?? tower.plan.frontAngle;
      const d = r - 2.2;
      // Out of the lift, facing into the tower.
      spot = { position: [center.x + Math.sin(angle) * d, y, center.z + Math.cos(angle) * d], yaw: angle };
    }
    const from = this.location.tower === tower ? this.location.floor : 0;
    this.hud.closePanel();
    this.travel = {
      towerId,
      from,
      to: plan.index,
      spot,
      time: 0,
      duration: Math.min(2.2, 0.9 + Math.abs(plan.index - from) * 0.03),
      moved: false,
      highlight: target.slotId ?? null,
    };
    this.analytics.track('elevator_boarded', { towerId, kind: 'fast', floor: from, destination: plan.index });
    this.hud.showTravel(this.travelLabel(this.travel, 0));
  }

  private stepTravel(dt: number): void {
    const travel = this.travel;
    if (!travel || !this.world) return;
    travel.time += dt;
    if (!travel.moved && travel.time >= TRAVEL_COVER_S) {
      travel.moved = true;
      this.teleport(travel.spot.position, travel.spot.yaw);
      this.pendingHighlight = travel.highlight;
    }
    const t = Math.min(1, travel.time / travel.duration);
    if (t >= 1) {
      this.travel = null;
      this.hud.showTravel(null);
    } else {
      this.hud.showTravel(this.travelLabel(travel, t));
    }
  }

  private travelLabel(travel: Travel, t: number): string {
    const tower = this.towers.get(travel.towerId)!;
    const eased = t * t * (3 - 2 * t);
    const floor = Math.round(travel.from + (travel.to - travel.from) * eased);
    return `${tower.plan.category.name.toUpperCase()} · FLOOR ${floor}`;
  }

  private liftPanel(tower: TowerState): LiftPanel {
    return {
      title: `${tower.plan.category.name} lifts`,
      subtitle: tower.plan.category.tagline ?? 'Pick a floor',
      destinations: this.destinations(tower.plan),
      floorCount: tower.plan.floorCount,
      towerId: tower.plan.id,
      go: (destination) => this.travelTo(destination.towerId, destination.floor, { liftIndex: this.nearLift?.position.liftIndex }),
      search: (query) => this.search(query),
    };
  }

  /** Search hook: where each matching world stands this window, or a direct way in. */
  search(query: string): SearchResultView[] {
    const window = this.rotation.currentWindow;
    return this.repository.search(query, 8).map(({ listing }) => {
      const found = this.service.locate(listing.id, window)[0];
      const tower = found ? this.towers.get(found.towerId) : undefined;
      const category = this.categories.get(listing.categories[0]);
      const by = listing.creator.name ? ` · ${listing.creator.name}` : '';
      return {
        title: listing.name,
        detail: `${category?.name ?? 'World'}${by}`,
        actionLabel: found && tower ? `${tower.plan.category.name} · Floor ${found.slot.floor}` : 'Enter',
        select: () => {
          this.analytics.track('search_result_selected', { query, listingId: listing.id, located: !!found });
          if (found && tower) this.travelTo(found.towerId, found.slot.floor, { slotId: found.slot.id });
          else this.enterListing(listing, null);
        },
      };
    });
  }

  /** Open the lift panel from anywhere (the location chip, the debug overlay). */
  openLifts(towerId?: string): void {
    const tower = (towerId ? this.towers.get(towerId) : null) ?? this.location.tower ?? this.towers.values().next().value;
    if (tower) this.hud.openPanel(this.liftPanel(tower));
  }

  // ── Building ─────────────────────────────────────────────────────────────

  private build(plan: CityPlan): void {
    const elevators = new Map([...this.towers].map(([id, tower]) => [id, tower.elevator]));
    this.teardown();
    this.plan = plan;
    for (const tower of plan.towers) {
      const shell = createTowerShell(tower, this.config, this.materials, this.options.interiorLayer);
      shell.setTheme(this.light);
      shell.setInteriorVisible(false);
      this.group.add(shell.group);
      // Keep a platform where it was if the tower did not change height under it.
      const previous = elevators.get(tower.id);
      const elevator = previous && previous.tower.floorCount === tower.floorCount ? previous : new DiscoveryElevator(tower, this.config, { arrived: () => {} });
      this.towers.set(tower.id, { plan: tower, shell, elevator, detail: null, platform: null });
    }
    this.bridges = new BridgeManager(plan, this.config, this.materials, this.categories);
    this.group.add(this.bridges.group);

    // The edge of the city: an invisible fence, facing in.
    const r = plan.groundRadius;
    this.fence = new Mesh(flipInside(new CylinderGeometry(r, r, 30, 96, 1, true)).translate(0, 15, 0));
    this.fence.visible = false;
    this.fence.updateMatrixWorld(true);

    this.service.setTowers(plan.towers.map((tower) => ({ towerId: tower.id, categoryId: tower.category.id, slots: tower.floors.flatMap((floor) => floor.slots) })));
    this.rotation.refresh();
    this.active = [];
    if (this.world) this.syncTo(this.world.getState().position);
  }

  private teardown(): void {
    for (const tower of this.towers.values()) {
      this.unloadDetail(tower);
      tower.shell.dispose();
    }
    this.towers.clear();
    this.bridges?.dispose();
    this.bridges = null;
    this.fence?.geometry.dispose();
    this.fence = null;
    this.plan = null;
  }

  private loadDetail(tower: TowerState): TowerDetail {
    if (tower.detail) return tower.detail;
    const detail = new TowerDetail(
      tower.plan,
      this.geometry,
      {
        config: this.config,
        materials: this.materials,
        interiorLayer: this.options.interiorLayer,
        acquireDoor: () => this.acquireDoor(),
        releaseDoor: (door) => this.releaseDoor(door),
        onDoorLoaded: (door) => {
          this.loaded.add(door);
          this.loadedDirty = true;
          this.rotation.attach(door);
        },
        onDoorUnloaded: (door) => {
          this.loaded.delete(door);
          this.loadedDirty = true;
          this.impressions.delete(door);
          if (door === this.focus) this.setFocus(null);
          this.rotation.detach(door);
        },
      },
      this.liftDoorMaterial,
    );
    this.group.add(detail.group);
    tower.detail = detail;
    tower.platform = new ElevatorView(tower.elevator, this.config, this.materials, this.options.interiorLayer);
    this.group.add(tower.platform.group);
    tower.shell.setInteriorVisible(true);
    return detail;
  }

  private unloadDetail(tower: TowerState): void {
    tower.detail?.dispose();
    tower.detail = null;
    tower.platform?.dispose();
    tower.platform = null;
    tower.shell.setInteriorVisible(false);
  }

  private acquireDoor(): DoorView {
    const door = this.pool.pop() ?? new DoorView(this.doorResources);
    door.setTheme(this.light);
    return door;
  }

  private releaseDoor(door: DoorView): void {
    door.release();
    if (this.pool.length < 96) this.pool.push(door);
    else door.dispose();
  }

  private doorList(): DoorView[] {
    if (this.loadedDirty) {
      this.loadedList = [...this.loaded];
      this.loadedDirty = false;
    }
    return this.loadedList;
  }

  // ── Per frame ────────────────────────────────────────────────────────────

  private playerPosition(): Vec3Tuple {
    return this.world?.getState().position ?? [0, 0, 0];
  }

  private floorAt(tower: TowerPlan, y: number): number {
    return Math.max(0, Math.min(tower.floorCount - 1, Math.round(y / this.config.floorHeight)));
  }

  private locate(x: number, y: number, z: number): void {
    let inside: TowerState | null = null;
    const outer = this.config.towerRadius + this.config.wallThickness;
    for (const tower of this.towers.values()) {
      if (Math.hypot(x - tower.plan.center.x, z - tower.plan.center.z) < outer) inside = tower;
    }
    const bridge = inside ? null : (this.bridges?.locate(x, y, z) ?? null);
    const floor = inside ? this.floorAt(inside.plan, y) : Math.max(0, Math.round(y / this.config.floorHeight));
    this.location = { tower: inside, floor, bridge };
  }

  /** Load the floors around the player in every tower close enough to see into. */
  private stream(y: number): void {
    const { floorsPerChunk: n, chunkRadius, detailDistance, towerRadius } = this.config;
    const [px, , pz] = this.playerPosition();
    const cameraY = this.options.camera.position.y;
    for (const tower of this.towers.values()) {
      const distance = Math.hypot(px - tower.plan.center.x, pz - tower.plan.center.z) - towerRadius;
      if (distance > detailDistance && tower !== this.location.tower) {
        if (tower.detail) this.unloadDetail(tower);
        continue;
      }
      const detail = this.loadDetail(tower);
      const floor = this.floorAt(tower.plan, y);
      const chunk = Math.floor(floor / n);
      detail.setRange((chunk - chunkRadius) * n, (chunk + chunkRadius + 1) * n - 1);
      const cameraFloor = this.floorAt(tower.plan, cameraY - 1.2);
      detail.setVisibleFloors(Math.min(floor, cameraFloor) - 1, Math.max(floor, cameraFloor) + 1);
      detail.setOpenGate(tower.elevator.state === 'docked' ? tower.elevator.floor : null);
    }
  }

  /**
   * The railing rose while someone stood where it closes: step them back onto
   * the floor rather than leave them inside it, over the shaft.
   */
  private keepOffShaftEdge(x: number, y: number, z: number): void {
    const tower = this.location.tower;
    if (!tower || !this.world || tower === this.rider) return;
    const { center } = tower.plan;
    const d = Math.hypot(x - center.x, z - center.z);
    const rail = this.config.shaftRadius + 0.28;
    const floorY = floorSurface(tower.plan.floors[this.location.floor], this.config);
    if (d > rail + 0.2 || d < this.config.platformRadius - 0.3 || Math.abs(y - floorY) > 0.5) return;
    if (tower.detail?.gateFloor === this.location.floor) return;
    const scale = (rail + 0.45) / Math.max(d, 1e-3);
    this.world.setState({ position: [center.x + (x - center.x) * scale, y, center.z + (z - center.z) * scale] });
  }

  private findRider(x: number, y: number, z: number, onGround: boolean): TowerState | null {
    for (const tower of this.towers.values()) {
      const d = Math.hypot(x - tower.plan.center.x, z - tower.plan.center.z);
      if (d < this.config.platformRadius - 0.1 && Math.abs(y - tower.elevator.y) < (onGround ? 0.35 : 0.05) + (tower === this.rider ? 0.3 : 0)) return tower;
    }
    return null;
  }

  private updateColliders(position: Vec3Tuple): void {
    const list: Mesh[] = [];
    if (this.fence) list.push(this.fence);
    if (this.bridges) list.push(...this.bridges.colliders);
    for (const tower of this.towers.values()) {
      list.push(...tower.shell.colliders);
      if (!tower.detail || !tower.platform) continue;
      const floor = this.floorAt(tower.plan, position[1]);
      list.push(...tower.detail.colliders(floor - 1, floor + 1));
      list.push(tower.platform.deck);
      if (tower.elevator.state === 'moving') list.push(tower.platform.rail);
    }
    const same = list.length === this.active.length && list.every((mesh, i) => mesh === this.active[i]);
    if (same) return;
    this.active = list;
    this.world?.refreshColliders();
  }

  /** The door someone is standing in front of, and walking into it. */
  private updateFocus(x: number, y: number, z: number): void {
    this.nearLift = null;
    this.nearCall = null;
    const tower = this.location.tower;
    if (!tower || this.blocked || this.travel || tower === this.rider) {
      this.setFocus(null);
      return;
    }
    const { center } = tower.plan;
    const floor = this.location.floor;
    const floorY = floorSurface(tower.plan.floors[floor], this.config);
    if (Math.abs(y - floorY) > 1.6) {
      this.setFocus(null);
      return;
    }
    const r = this.config.towerRadius;
    const dx = x - center.x;
    const dz = z - center.z;
    const d = Math.hypot(dx, dz);
    const angle = Math.atan2(dx, dz);

    let best: DoorView | null = null;
    let bestDepth = this.config.doorReach;
    for (const door of this.doorList()) {
      if (door.towerId !== tower.plan.id || door.floor !== floor || !door.listing) continue;
      const depth = r - 0.14 - d * Math.cos(angle - door.angle);
      const lateral = d * Math.sin(angle - door.angle);
      if (depth < 0 || Math.abs(lateral) > this.config.doorWidth / 2 + 0.6) continue;
      if (depth < bestDepth) {
        bestDepth = depth;
        best = door;
      }
      // Pressed right up against it: through the door.
      if (door.enterable && depth < this.config.enterDepth && Math.abs(lateral) < this.config.doorWidth / 2 - 0.25) {
        this.enterDoor(door, 'walk');
        return;
      }
    }
    this.setFocus(best);

    if (!best) {
      for (const position of tower.plan.floors[floor].positions) {
        if (position.kind !== 'lift') continue;
        const depth = r - d * Math.cos(angle - position.angle);
        const lateral = d * Math.sin(angle - position.angle);
        if (depth > 0 && depth < LIFT_REACH && Math.abs(lateral) < 1.8) this.nearLift = { tower, position };
      }
      const rail = this.config.shaftRadius + 0.28;
      if (!this.nearLift && d < rail + CALL_REACH && !tower.elevator.isDockedAt(floor)) this.nearCall = tower;
    }
  }

  private setFocus(door: DoorView | null): void {
    if (door === this.focus) {
      if (!door) return;
      const key = `${door.slotId}/${door.listing?.id}`;
      if (key === this.focusKey) return;
    }
    this.focus?.setFocus(false);
    this.focus = door;
    this.focusKey = door ? `${door.slotId}/${door.listing?.id}` : '';
    door?.setFocus(true);
    if (door?.listing && door.slotId) {
      const [x, , z] = this.playerPosition();
      this.analytics.track('door_focused', { listingId: door.listing.id, slotId: door.slotId, distance: Math.round(Math.hypot(door.center.x - x, door.center.z - z) * 10) / 10 });
    }
  }

  /** E, a tap on the prompt, or the interact button. */
  private act(via: 'key' | 'tap'): boolean {
    if (this.blocked || this.travel) return false;
    if (this.focus?.enterable) {
      this.enterDoor(this.focus, via);
      return true;
    }
    if (this.nearLift) {
      this.hud.openPanel(this.liftPanel(this.nearLift.tower));
      return true;
    }
    if (this.nearCall) {
      this.nearCall.elevator.call(this.location.floor);
      return true;
    }
    if (this.rider) {
      this.ride(this.rider.elevator.direction === 0 ? 1 : 0);
      return true;
    }
    return false;
  }

  private ride(direction: -1 | 0 | 1): void {
    this.rider?.elevator.setDirection(direction);
  }

  private enterDoor(door: DoorView, via: 'walk' | 'key' | 'tap'): void {
    const listing = door.listing;
    if (!listing || !door.slotId || this.blocked) return;
    this.analytics.track('door_interacted', { listingId: listing.id, slotId: door.slotId, via });
    const tower = this.towers.get(door.towerId ?? '');
    const y = tower ? floorSurface(tower.plan.floors[door.floor], this.config) : door.center.y - door.mesh.geometry.parameters.height / 2 - this.config.doorSill;
    const out = door.center.clone().addScaledVector(door.normal, 2.4);
    // Come back out of this door, facing into the tower.
    this.enterListing(listing, { position: [out.x, y, out.z], yaw: door.angle }, door);
  }

  private enterListing(listing: WorldListing, returnTo: WalkSpot | null, door: DoorView | null = null): void {
    const state = this.world?.getState();
    const spot = returnTo ?? { position: state?.position ?? [0, 0, 0], yaw: state?.yaw ?? 0 };
    this.analytics.track('world_entered', { listingId: listing.id, url: listing.url, slotId: door?.slotId ?? null, towerId: door?.towerId ?? null });
    this.analytics.flush();
    if (door) door.highlight = 2;
    this.setBlocked(true);
    this.options.onEnterWorld(listing, spot);
  }

  private trackImpressions(dt: number, x: number, z: number): void {
    for (const door of this.doorList()) {
      if (!door.listing || !door.slotId || door.tier === 'still' || Math.hypot(door.center.x - x, door.center.z - z) > IMPRESSION_DISTANCE) {
        this.impressions.delete(door);
        continue;
      }
      const seen = (this.impressions.get(door) ?? 0) + dt;
      this.impressions.set(door, seen);
      const key = `${door.slotId}/${door.listing.id}`;
      if (seen >= IMPRESSION_S && !this.impressed.has(key)) {
        this.impressed.add(key);
        this.analytics.track('world_impression', { listingId: door.listing.id, slotId: door.slotId, towerId: door.towerId!, floor: door.floor });
      }
    }
  }

  private trackFloorVisit(dt: number): void {
    const { tower, floor } = this.location;
    const key = tower ? `${tower.plan.id}:${floor}` : '';
    if (key !== this.floorVisit.key) this.floorVisit = { key, time: 0, tracked: false };
    if (!tower || this.floorVisit.tracked) return;
    this.floorVisit.time += dt;
    if (this.floorVisit.time >= FLOOR_VISIT_S) {
      this.floorVisit.tracked = true;
      this.analytics.track('floor_visited', { towerId: tower.plan.id, floor });
    }
  }

  private trackBridge(): void {
    const on = this.location.bridge;
    if (!on) return;
    const side = on.t < 0.5 ? 0 : 1;
    const previous = this.bridgeSide.get(on.bridge.id);
    this.bridgeSide.set(on.bridge.id, side);
    if (previous === undefined || previous === side) return;
    const { bridge } = on;
    this.analytics.track('bridge_crossed', { bridgeId: bridge.id, from: side === 1 ? bridge.from : bridge.to, to: side === 1 ? bridge.to : bridge.from });
  }

  private updateHud(): void {
    const { tower, floor, bridge } = this.location;
    const busy = this.blocked || !!this.travel;
    if (bridge) {
      const to = this.categories.get(bridge.t < 0.5 ? bridge.bridge.to : bridge.bridge.from);
      this.hud.setLocation(`Bridge · to ${to?.name ?? '…'}`);
    } else if (tower) {
      this.hud.setLocation(`${tower.plan.category.name} · Floor ${floor} · ${titleCase(tower.plan.floors[floor].title)}`);
    } else {
      this.hud.setLocation(null);
    }

    if (this.rider) {
      const elevator = this.rider.elevator;
      const at = this.floorAt(this.rider.plan, elevator.y);
      const arrow = elevator.direction > 0 ? '▲' : elevator.direction < 0 ? '▼' : '■';
      this.hud.setRide(`${arrow} ${at} · ${titleCase(this.rider.plan.floors[at].title)}`);
    } else {
      this.hud.setRide(null);
    }

    const touch = this.options.touch;
    let prompt: string | null = null;
    if (!busy && !this.hud.panelOpen) {
      if (this.focus?.listing) {
        const name = this.focus.listing.name;
        prompt = this.focus.enterable ? (touch ? `Tap to enter ${name}` : `Walk in or press E · ${name}`) : 'Reassigning…';
      } else if (this.nearLift) {
        prompt = touch ? 'Tap to take the lift' : 'Press E to take the lift';
      } else if (this.nearCall) {
        const coming = this.nearCall.elevator.called;
        prompt = coming ? 'The platform is on its way' : touch ? 'Tap to call the platform' : 'Press E to call the platform';
      }
    }
    this.hud.setPrompt(prompt);
  }

  private applyTheme(): void {
    this.materials.setTheme(this.light);
    for (const tower of this.towers.values()) tower.shell.setTheme(this.light);
    for (const door of [...this.loaded, ...this.pool]) door.setTheme(this.light);
  }

  private handleKey = (event: KeyboardEvent) => {
    if (!this.rider || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.code === 'KeyR') this.ride(1);
    else if (event.code === 'KeyF') this.ride(-1);
    else if (event.code === 'KeyX') this.ride(0);
  };
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s·-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** The face of a fast lift's doors: two panels and a small plate. */
function liftTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#34363c';
  ctx.fillRect(0, 0, 128, 256);
  ctx.fillStyle = '#1b1c20';
  ctx.fillRect(63, 0, 2, 256);
  ctx.fillStyle = '#f1e7d0';
  ctx.fillRect(40, 18, 48, 3);
  ctx.font = '700 15px Urbanist, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LIFT', 64, 40);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  return texture;
}

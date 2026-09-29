import type { AvatarExpression } from './player/avatar.js';
import type { Camera, Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

export type Vec3Tuple = [number, number, number];

/** Camera modes every WorldMesh world supports. */
export type ViewMode = 'first' | 'third';

/**
 * Optional movement capabilities. A world declares what it allows;
 * the shared controller implements it. Worlds never rewrite the controller.
 *
 * `climbing`, `swimming` and `vehicles` are reserved: they are part of the
 * standard's vocabulary but are not implemented yet, so enabling one logs a
 * notice instead of silently doing nothing.
 */
export interface Abilities {
  /** One extra jump while airborne. */
  doubleJump: boolean;
  /** Toggle free-flight with the fly key (default F). */
  flying: boolean;
  /** Hold crouch key (default C) to lower the player and slow down. */
  crouching: boolean;
  /** Burst of speed in the input direction (default Q). */
  dash: boolean;
  /** Reserved — not implemented yet. */
  climbing: boolean;
  /** Reserved — not implemented yet. */
  swimming: boolean;
  /** Reserved — not implemented yet. */
  vehicles: boolean;
}

/** Every logical action the runtime understands, mapped to KeyboardEvent.code values. */
export interface Keymap {
  forward: string[];
  backward: string[];
  left: string[];
  right: string[];
  jump: string[];
  sprint: string[];
  interact: string[];
  toggleView: string[];
  crouch: string[];
  fly: string[];
  dash: string[];
}

export type InputAction = keyof Keymap;

export interface MovementTuning {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  flySpeed: number;
  jumpSpeed: number;
  gravity: number;
  /** How fast ground velocity approaches the target (1/s). */
  groundAccel: number;
  /** How fast air velocity approaches the target (1/s). */
  airAccel: number;
  dashSpeed: number;
  dashCooldown: number;
  /** Terminal falling speed. */
  maxFallSpeed: number;
  /** Anything below this Y counts as "fell out of the world" and respawns. */
  fallLimit: number;
}

export interface PlayerOptions {
  /** Total standing height in metres. */
  height?: number;
  /** Collision radius in metres. */
  radius?: number;
  /** Eye offset from the feet in metres. Defaults to height - 0.2. */
  eyeHeight?: number;
  /** Replace the default white figure, or pass `false` for no avatar at all. */
  avatar?: Object3D | false;
}

export interface ViewOptions {
  mode?: ViewMode;
  /** Third-person boom length in metres. */
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Mouse sensitivity, radians per pixel. */
  sensitivity?: number;
  /** Start looking along this yaw, in radians. 0 looks down -Z. */
  yaw?: number;
  pitch?: number;
}

export type PortalMode = 'interact' | 'auto';

export interface PortalOptions {
  /** Destination world URL. Absolute, on the destination's own host. */
  url: string;
  /** Human label shown in the interact prompt. */
  label?: string;
  position: Vec3Tuple;
  /** Trigger radius in metres. */
  radius?: number;
  /** `interact` (press E) or `auto` (walk through). Defaults to `interact`. */
  mode?: PortalMode;
  color?: number | string;
  /** Skip the built-in ring mesh and use the world's own geometry. */
  visual?: Object3D | false;
}

export interface UiOptions {
  /** Crosshair dot in first person. */
  crosshair?: boolean;
  /** Bottom-left WorldMesh badge linking back to the hub. */
  badge?: boolean;
  /** Where the badge links. */
  hubUrl?: string;
  /** Click-to-enter overlay and the shared controls legend. */
  controlsHint?: boolean;
  /** World name shown in the overlay. */
  title?: string;
}

/** Everything another peer would need to draw this player. Serializable on purpose. */
export interface PlayerState {
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  yaw: number;
  pitch: number;
  /** Where the body faces; in third person it can differ from the camera's yaw. */
  facing: number;
  onGround: boolean;
  crouching: boolean;
  flying: boolean;
  /** The face the default figure is pulling, picked with the number keys. */
  expression: AvatarExpression;
}

export interface WorldMeshEvents {
  /** Fired every simulation step, after movement resolves. */
  update: { dt: number; state: PlayerState };
  /** Player crossed into a portal trigger. */
  'portal:enter': { portal: PortalOptions };
  'portal:exit': { portal: PortalOptions };
  /** Navigation is about to happen. Call `preventDefault()` to take over. */
  'portal:activate': { portal: PortalOptions; url: string; preventDefault(): void };
  'view:change': { mode: ViewMode };
  'pointer:lock': { locked: boolean };
  /** E pressed with nothing else claiming it. */
  interact: { position: Vec3Tuple };
  respawn: { reason: 'fell' | 'manual' };
}

/**
 * Multiplayer seam. Nothing in the runtime implements this yet — it exists so
 * the local player loop stays shaped like something a network can drive later
 * (peer-to-peer, a world-hosted server, or a WorldMesh signaling service).
 */
export interface NetworkAdapter {
  /** Called once with a read-only view of the local world. */
  attach(world: WorldMeshHandle): void;
  /** Called with the local player's state at the network tick rate. */
  sendLocalState?(state: PlayerState): void;
  /** Called by the adapter when a remote peer's state arrives. */
  onRemoteState?(peerId: string, state: PlayerState): void;
  detach?(): void;
}

export interface WorldMeshOptions {
  scene: Scene;
  camera: Camera | PerspectiveCamera;
  renderer: WebGLRenderer;
  /** Where the player starts. Defaults to [0, 2, 0]. */
  spawn?: Vec3Tuple;
  abilities?: Partial<Abilities>;
  /**
   * Meshes the player can stand on and bump into. Pass a function if the world
   * builds geometry lazily. Empty means "flat ground at spawn Y level 0".
   */
  colliders?: Object3D[] | (() => Object3D[]);
  portals?: PortalOptions[];
  player?: PlayerOptions;
  view?: ViewOptions;
  keymap?: Partial<Keymap>;
  movement?: Partial<MovementTuning>;
  ui?: UiOptions;
  /** Ground plane height used when a world provides no colliders. */
  groundLevel?: number;
  /** Run the render loop for you. Defaults to true. */
  autoStart?: boolean;
  /** Handle resize for you (camera aspect + renderer size). Defaults to true. */
  autoResize?: boolean;
  /** Your per-frame world logic. Runs after movement, before rendering. */
  onUpdate?: (dt: number, world: WorldMeshHandle) => void;
  /** Reserved. Not used by the MVP. */
  network?: NetworkAdapter;
}

export interface WorldMeshHandle {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly renderer: WebGLRenderer;
  readonly abilities: Readonly<Abilities>;
  /** The avatar root. Move it and you move the player. */
  readonly avatar: Object3D | null;

  start(): void;
  stop(): void;
  /** Advance the simulation by `dt` seconds without rendering. */
  update(dt: number): void;
  dispose(): void;

  getState(): PlayerState;
  setState(state: Partial<PlayerState>): void;
  teleport(position: Vec3Tuple, yaw?: number): void;
  respawn(): void;

  setViewMode(mode: ViewMode): void;
  getViewMode(): ViewMode;

  addPortal(portal: PortalOptions): void;
  /** Navigate to another WorldMesh world, carrying a `from` back-reference. */
  travelTo(url: string): void;

  on<K extends keyof WorldMeshEvents>(event: K, fn: (payload: WorldMeshEvents[K]) => void): () => void;
  off<K extends keyof WorldMeshEvents>(event: K, fn: (payload: WorldMeshEvents[K]) => void): void;

  /** Refresh the collider list after the world adds geometry. */
  refreshColliders(): void;
}

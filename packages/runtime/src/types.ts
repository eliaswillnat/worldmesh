import type { AvatarDescriptor } from './avatar/descriptor.js';
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

/**
 * Let visitors bring their own character. Entirely optional: without it, or
 * whenever resolving or loading fails, the player keeps the world's body.
 *
 * - `worldmesh`: the avatar the visitor picked in their WorldMesh Avatar
 *   Wallet, handed over through the URL fragment when they arrive from the
 *   hub or another world. The model loads from the avatar platform itself;
 *   this world never sees the visitor's account or platform credentials.
 * - `descriptor`: an avatar the world resolved on its own.
 */
export type AvatarOptions =
  | {
      source: 'worldmesh';
      /** The WorldMesh hub that resolves handoff tickets. Defaults to https://worldmesh.net/. */
      hubUrl?: string;
      /** Refuse models larger than this many bytes. Defaults to 40 MB. */
      maxBytes?: number;
    }
  | {
      source: 'descriptor';
      descriptor: AvatarDescriptor;
      maxBytes?: number;
    };

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
  /** Crosshair dot in the middle of the screen. Off unless set to true. */
  crosshair?: boolean;
  /** Bottom-left WorldMesh badge linking back to the hub. */
  badge?: boolean;
  /** Where the badge links. */
  hubUrl?: string;
  /** Click-to-enter overlay and the shared controls legend. */
  controlsHint?: boolean;
  /** World name shown in the overlay. */
  title?: string;
  /**
   * Hide the click-to-enter panel until the visitor has entered once and then
   * pressed Esc. The first screen stays clear; a click/tap still starts them.
   */
  deferLockPanel?: boolean;
  /**
   * Walking starts immediately. The keyboard, the on-screen joysticks and
   * mouse look (with the cursor visible) work before any click, and Esc holds
   * them until Continue. The first click captures the cursor for unlimited turning.
   */
  moveBeforeLock?: boolean;
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
  /** The visitor's own avatar replaced the default body. */
  'avatar:load': { descriptor: AvatarDescriptor };
  /** An external avatar could not be shown; the default body stays. */
  'avatar:error': { descriptor: AvatarDescriptor | null; error: unknown };
  /** People in this world including the visitor, or null while not connected. Only with `multiplayer`. */
  players: { count: number | null };
  /** The presence relay refused the join because the room is at capacity. */
  'room:full': { full: boolean };
  /** An immersive-vr session started. */
  'vr:enter': Record<string, never>;
  /** The immersive-vr session ended. */
  'vr:exit': Record<string, never>;
}

/** Someone else's body, an upright cylinder the local player cannot walk through. */
export interface PeerBody {
  /** Feet position in world space. */
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

/**
 * Multiplayer seam. `multiplayer` plugs in the built-in relay client; pass
 * your own adapter here to network the world some other way.
 */
export interface NetworkAdapter {
  /** Called once with a read-only view of the local world. */
  attach(world: WorldMeshHandle): void;
  /** Called with the local player's state at the network tick rate. */
  sendLocalState?(state: PlayerState): void;
  /** Called by the adapter when a remote peer's state arrives. */
  onRemoteState?(peerId: string, state: PlayerState): void;
  /** Where everyone else is standing right now. The local player is kept out of them. */
  bodies?(): Iterable<PeerBody>;
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
  /** Show the visitor's own avatar. Off by default. */
  avatar?: AvatarOptions;
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
  /**
   * Show everyone else who is in this world. `true` uses the relay WorldMesh
   * hosts; `{ server }` points at your own copy of workers/presence.
   * Ignored when `network` is set.
   */
  multiplayer?: boolean | MultiplayerOptions;
  /** A custom network layer. Replaces `multiplayer`. */
  network?: NetworkAdapter;
  /**
   * Offer immersive VR through the shared Enter VR control. Defaults to true.
   * The button only appears when the browser can start an `immersive-vr` session.
   */
  vr?: boolean;
}

export interface MultiplayerOptions {
  /** WebSocket base URL of a presence relay, e.g. `wss://relay.example.com`. */
  server?: string;
}

export interface WorldMeshHandle {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly renderer: WebGLRenderer;
  readonly abilities: Readonly<Abilities>;
  /** The avatar root. Move it and you move the player. */
  readonly avatar: Object3D | null;
  /** The external avatar being shown, or null while the default body is. */
  readonly avatarDescriptor: AvatarDescriptor | null;

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

  /** Show an external avatar. Resolves to false (default body kept) if it cannot be loaded. */
  loadAvatar(descriptor: AvatarDescriptor): Promise<boolean>;
  /** Go back to the world's default body. */
  clearAvatar(): void;

  /** Refresh the collider list after the world adds geometry. */
  refreshColliders(): void;

  /** Start an immersive-vr session. Resolves false if the browser refuses. */
  enterVR(): Promise<boolean>;
  /** End the immersive-vr session, if one is running. */
  exitVR(): Promise<void>;
  /** True while a WebXR immersive-vr session is presenting. */
  isVR(): boolean;
}

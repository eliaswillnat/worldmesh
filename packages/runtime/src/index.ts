export { createWorldMesh } from './core/worldmesh.js';
export { Emitter } from './core/events.js';
export { Input } from './controls/input.js';
export { TouchControls, isTouchDevice } from './controls/touch.js';
export { DEFAULT_KEYMAP, resolveKeymap } from './controls/keymap.js';
export { DEFAULT_ABILITIES, resolveAbilities } from './abilities/abilities.js';
export { CollisionWorld } from './movement/collision.js';
export { DEFAULT_TUNING, MovementController } from './movement/controller.js';
export { CameraRig } from './camera/cameraRig.js';
export { Player } from './player/player.js';
export {
  AVATAR_EXPRESSIONS,
  animateDefaultAvatar,
  createDefaultAvatar,
  expressionForDigit,
  getAvatarExpression,
  isAvatarExpression,
  setAvatarExpression,
} from './player/avatar.js';
export type { AvatarExpression, AvatarMotion } from './player/avatar.js';
export { PortalManager, buildTravelUrl, getReferringWorld } from './portals/portals.js';
export { Overlay } from './ui/overlay.js';
export { deserializePlayerState, serializePlayerState } from './net/adapter.js';

export const WORLDMESH_VERSION = '0.1.0';
/** Bumped when the world-facing contract changes in an incompatible way. */
export const WORLDMESH_PROTOCOL = 1;

export type {
  Abilities,
  InputAction,
  Keymap,
  MovementTuning,
  NetworkAdapter,
  PlayerOptions,
  PlayerState,
  PortalMode,
  PortalOptions,
  UiOptions,
  Vec3Tuple,
  ViewMode,
  ViewOptions,
  WorldMeshEvents,
  WorldMeshHandle,
  WorldMeshOptions,
} from './types.js';

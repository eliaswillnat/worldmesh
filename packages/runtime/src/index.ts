export { createWorldMesh } from './core/worldmesh';
export { Emitter } from './core/events';
export { Input } from './controls/input';
export { TouchControls, isTouchDevice } from './controls/touch';
export { DEFAULT_KEYMAP, resolveKeymap } from './controls/keymap';
export { DEFAULT_ABILITIES, resolveAbilities } from './abilities/abilities';
export { CollisionWorld } from './movement/collision';
export { DEFAULT_TUNING, MovementController } from './movement/controller';
export { CameraRig } from './camera/cameraRig';
export { Player } from './player/player';
export {
  AVATAR_EXPRESSIONS,
  animateDefaultAvatar,
  createDefaultAvatar,
  expressionForDigit,
  getAvatarExpression,
  isAvatarExpression,
  setAvatarExpression,
} from './player/avatar';
export type { AvatarExpression, AvatarMotion } from './player/avatar';
export { PortalManager, buildTravelUrl, getReferringWorld } from './portals/portals';
export { Overlay } from './ui/overlay';
export { deserializePlayerState, serializePlayerState } from './net/adapter';

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
} from './types';

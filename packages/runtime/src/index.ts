export { createWorldMesh } from './core/worldmesh.js';
export { Emitter } from './core/events.js';
export { Input } from './controls/input.js';
export { TouchControls, isTouchDevice } from './controls/touch.js';
export { DEFAULT_KEYMAP, resolveKeymap } from './controls/keymap.js';
export { DEFAULT_ABILITIES, resolveAbilities } from './abilities/abilities.js';
export { CollisionWorld } from './movement/collision.js';
export { DEFAULT_TUNING, MovementController } from './movement/controller.js';
export { CameraRig } from './camera/cameraRig.js';
export { VIEW_PARAM, VIEW_STORAGE_KEY, getRememberedView, rememberView, takeViewHandoff, withView } from './camera/viewHandoff.js';
export { Player } from './player/player.js';
export {
  AVATAR_EXPRESSIONS,
  animateDefaultAvatar,
  createDefaultAvatar,
  expressionForDigit,
  getAvatarExpression,
  isAvatarExpression,
  setAvatarExpression,
  setAvatarAppear,
  setAvatarColor,
} from './player/avatar.js';
export type { AvatarExpression, AvatarMotion } from './player/avatar.js';
export { isStrokeMaterial, setFigureStroke, setStrokeOpacity } from './player/stroke.js';
export { PortalManager, buildTravelUrl, getReferringWorld } from './portals/portals.js';
export { isLoadableUrl, parseAvatarDescriptor } from './avatar/descriptor.js';
export type { AvatarDescriptor, AvatarFormat } from './avatar/descriptor.js';
export {
  AVATAR_TICKET_PARAM,
  AVATAR_TICKET_STORAGE_KEY,
  getAvatarTicket,
  resolveWorldMeshAvatar,
  setAvatarTicket,
  takeAvatarTicket,
  withAvatarTicket,
} from './avatar/handoff.js';
export { loadAvatarModel } from './avatar/loader.js';
export type { LoadAvatarOptions, LoadedAvatar } from './avatar/loader.js';
export { Overlay } from './ui/overlay.js';
export { deserializePlayerState, serializePlayerState } from './net/adapter.js';
export { DEFAULT_PRESENCE_SERVER, Presence } from './net/presence.js';
export type { PresenceOptions } from './net/presence.js';

export const WORLDMESH_VERSION = '0.2.0';
/** Bumped when the world-facing contract changes in an incompatible way. */
export const WORLDMESH_PROTOCOL = 1;

export type {
  Abilities,
  AvatarOptions,
  InputAction,
  Keymap,
  MovementTuning,
  MultiplayerOptions,
  NetworkAdapter,
  PeerBody,
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

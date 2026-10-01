import type { NetworkAdapter, PlayerState } from '../types.js';

/**
 * The built-in implementation is `Presence` (presence.ts), enabled with the
 * `multiplayer` option. Anything else that implements `NetworkAdapter` can be
 * passed as `network` instead.
 */
export type { NetworkAdapter, PlayerState };

/** Round trip a player state over the wire. Kept tiny on purpose. */
export function serializePlayerState(state: PlayerState): string {
  return JSON.stringify(state);
}

export function deserializePlayerState(payload: string): PlayerState {
  return JSON.parse(payload) as PlayerState;
}

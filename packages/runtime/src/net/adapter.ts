import type { NetworkAdapter, PlayerState } from '../types';

/**
 * Multiplayer is intentionally NOT implemented. This file exists to pin down
 * the seam so the runtime stays easy to network later:
 *
 *  - the local player is simulated from serializable `PlayerState`, so a peer's
 *    state can drive an identical avatar with no movement-code changes;
 *  - the runtime exposes `update(dt)` separately from rendering, so a fixed
 *    network tick can drive it;
 *  - nothing in movement/camera/portals reaches for a global connection.
 *
 * Expected eventual topologies, in order of how much WorldMesh has to host:
 *  1. peer-to-peer WebRTC, worlds exchange state directly;
 *  2. a multiplayer server run by the world's own creator;
 *  3. optional WorldMesh signaling/discovery only (no game traffic);
 *  4. an optional hosted fallback, last resort.
 */
export type { NetworkAdapter, PlayerState };

/** Round trip a player state over the wire. Kept tiny on purpose. */
export function serializePlayerState(state: PlayerState): string {
  return JSON.stringify(state);
}

export function deserializePlayerState(payload: string): PlayerState {
  return JSON.parse(payload) as PlayerState;
}

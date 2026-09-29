# Roadmap

## Done (MVP)

- `@worldmesh/runtime`: input, movement, abilities, first/third person camera,
  player, portals, shared overlay.
- Five independently deployable demo worlds, none of which contains a line of
  navigation code.
- A hub that lists worlds and accepts a pasted URL.
- A tiny optional `worldmesh.json` manifest convention.
- Hub walk mode: the directory as a 3D lobby with a wormhole per world, and
  shared presence (see who else is in the lobby) through a Durable Object
  relay in `workers/presence`, wired in via the runtime's `NetworkAdapter`.

## Deliberately not built

Authentication, user profiles, social feeds, chat, friends, a database,
payments, moderation, AI generation, multiplayer, inventory, creator
dashboards. None of these are needed to prove the premise, and each one would
push hosting costs onto WorldMesh instead of onto the creators.

## Likely next, roughly in order

1. **Publish `@worldmesh/runtime` to npm.** Right now compatibility means
   "clone the monorepo". It should mean `npm i @worldmesh/runtime`. Needs a
   build step emitting JS + `.d.ts`, and a version policy for
   `WORLDMESH_PROTOCOL`.
2. **A compatibility checker.** Paste a URL, get a report: does it load, does
   it serve a manifest, does it call `createWorldMesh`, does `V` toggle the
   camera. Cheap to run client-side, and it makes the standard enforceable
   without a gatekeeper.
3. **Persist the directory.** The hub currently keeps pasted worlds in
   `localStorage`. A shared directory needs the smallest possible store — a
   static JSON file regenerated on submit would be enough for a long time.
4. **Better portal handoff.** Carry heading and velocity through `?from=`, and
   let a destination place arrivals at a matching exit portal rather than at
   spawn. Still plain navigation, just with more in the URL.
5. **Touch and gamepad input.** Same reasoning as the keyboard convention:
   it belongs in the runtime or it will diverge across worlds.
6. **Multiplayer, in the order that keeps WorldMesh cheapest.**
   1. Peer-to-peer WebRTC between visitors in the same world.
   2. World-hosted servers, for worlds whose creators want authority.
   3. Optional WorldMesh signaling/discovery — introductions only, no game
      traffic.
   4. An optional hosted fallback, only if the first three prove insufficient.

   The runtime is already shaped for this: serializable `PlayerState`,
   `update(dt)` split from rendering, and an unimplemented `NetworkAdapter`
   marking the seam.

## Open questions

- Should the manifest be required for directory listing? Requiring it is a
  small tax on creators but makes discovery much better.
- How does a world advertise that it supports multiplayer, and on what
  endpoint, without WorldMesh becoming the registry of record?
- What happens when a listed world goes offline or changes into something
  else? Any answer involves moderation, which is why it is not in the MVP.

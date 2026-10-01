# Roadmap

## Done (MVP)

- `@worldmesh/runtime`: input, movement, abilities, first/third person camera,
  player, portals, shared overlay.
- Five independently deployable demo worlds, none of which contains a line of
  navigation code.
- A hub that lists worlds and accepts a pasted URL.
- A tiny optional `worldmesh.json` manifest convention.
- Hub walk mode: the directory as a 3D lobby with a door per world, and
  shared presence (see who else is in the lobby) through a Durable Object
  relay in `workers/presence`, wired in via the runtime's `NetworkAdapter`.

- Optional accounts (Google, Apple, GitHub, Discord via Better Auth on D1) with a one-time
  username, and a minimal ActivityPub foundation: creators are followable as
  `@name@worldmesh.net`, and a published world can be announced to their
  followers. See [accounts-and-federation.md](accounts-and-federation.md) for
  what is and is not interoperable yet.

- Paid billboard advertising in walk mode (€2, authorized with Stripe and
  captured only after manual review). See [advertising.md](advertising.md).

## Deliberately not built

Social feeds, chat, friends, payments (beyond billboard ads), moderation
(beyond reviewing ads), AI generation,
multiplayer, inventory, creator dashboards. None of these are needed to prove the premise, and each one would
push hosting costs onto WorldMesh instead of onto the creators.

## Likely next, roughly in order

1. **Publish `@worldmesh/runtime` to npm.** The package is now built rather than
   shipped as raw TypeScript: `npm run build:runtime` emits ESM + `.d.ts` into
   `packages/runtime/dist`, and the version policy for `WORLDMESH_PROTOCOL` is
   written down in [publishing.md](publishing.md). What is left is the publish
   itself, which needs the `@worldmesh` scope on npm and an account with access
   to it. Until then, compatibility still means "clone the monorepo".
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
6. **Multiplayer beyond presence.** `multiplayer: true` already shows
   everyone in a world (see compatibility.md). Next: visitors' Avatar Wallet
   bodies instead of the default figure, names for signed-in visitors, chat
   in worlds, and world-hosted servers for creators who want shared game
   state.

## Open questions

- Should the manifest be required for directory listing? Requiring it is a
  small tax on creators but makes discovery much better.
- How does a world advertise that it supports multiplayer, and on what
  endpoint, without WorldMesh becoming the registry of record?
- What happens when a listed world goes offline or changes into something
  else? Any answer involves moderation, which is why it is not in the MVP.

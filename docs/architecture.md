# Architecture

The guiding constraint: **WorldMesh should host as little as possible.** Every
decision below follows from that, plus one product principle — worlds may look
and behave completely differently, but navigation must feel familiar in all of
them.

## The shape of the system

```
   ┌──────────────┐        ┌──────────────────────────────────────┐
   │   The hub    │        │  Independently hosted worlds         │
   │ worldmesh.net│        │                                      │
   │              │        │  forest.example    mars.example      │
   │  a list of   │───────▶│  city.example      village.example   │
   │  URLs        │        │                                      │
   └──────────────┘        │  each one imports @worldmesh/runtime │
                           └──────────────────────────────────────┘
                                          │
                                          │ portals = ordinary links
                                          ▼
                              another creator's world, on
                              another creator's hosting
```

The hub holds URLs. The runtime holds conventions. Neither holds content.

## Decisions

### Monorepo with npm workspaces

No Turborepo, no pnpm, no Nx. `npm install` at the root links
`@worldmesh/runtime` into all six apps. Each app still builds and deploys on
its own — `apps/forest` has no idea `apps/mars` exists except for a URL in a
portal config.

### TypeScript for the runtime

The runtime *is* the standard. Types are the cheapest possible specification:
a creator's editor tells them what `createWorldMesh` accepts without anyone
writing a spec document. Worlds could be plain JavaScript; the demos use TS
because they share the toolchain anyway.

### The runtime ships as source

`packages/runtime/package.json` points `exports` straight at `src/index.ts`.
Vite compiles it as part of each app's build, which means no build step and no
stale `dist/` during development. Publishing to npm later adds a build step;
nothing in the world-facing API changes when it does.

### `three` is a peer dependency

Each world owns its own `three` version and the runtime adapts. Every app sets
`resolve.dedupe: ['three']` so there is exactly one copy of three in the
bundle — two copies means `instanceof` checks fail and raycasting silently
breaks.

### The runtime owns the render loop — but does not have to

`createWorldMesh` starts a `requestAnimationFrame` loop that steps movement,
runs your `onUpdate`, and renders. That is what makes the three-line
integration real. A world that already has its own loop passes
`autoStart: false` and calls `world.update(dt)` itself. Simulation is separate
from rendering on purpose (see multiplayer below).

Movement runs in fixed substeps of at most 1/60s regardless of frame rate, so
a 144Hz machine and a stuttering laptop behave the same.

### Collision is two raycasts, not a physics engine

A world passes an array of meshes as `colliders`. The controller casts one ray
down to find the floor and four rays forward (at ankle, hip, chest and shoulder
height) to slide along walls. That is roughly 100 lines and no dependency.

It is deliberately not a physics engine. It cannot do moving platforms, ragdolls
or stacked dynamic bodies. It can do *walk around a world someone generated with
an AI tool*, which is the actual requirement. Worlds that need more can drive
`world.update()` themselves from their own physics step.

Ground sampling starts from where the feet **were**, not where they are, and
looks down far enough to cover the distance just fallen — otherwise a fast
faller crosses the floor between two frames and drops through the world.
When no collider is below the player at all, they keep falling until
`fallLimit` and respawn, instead of snapping onto an imaginary floor.

### Abilities are configuration, not subclasses

```js
abilities: { doubleJump: true, flying: false, dash: true }
```

One `MovementController` reads these flags. There is no `FlyingController`
extending `BaseController`. A world that wants double jump changes one line and
gets an implementation that behaves identically to every other world's double
jump — which is the whole point of a shared navigation standard.

`climbing`, `swimming` and `vehicles` are part of the declared vocabulary but
are not implemented yet; enabling one logs a notice rather than failing quietly.

### Portals are links

For the MVP, entering a portal is `window.location.href = destination`. A
`?from=` parameter carries the origin world so a destination can eventually
say "you arrived from X" or place you at a matching exit.

This is not a placeholder for something better — it is the same bet the web
made. A link works across hosts, survives the destination being rewritten, and
needs no coordination between the two sites. Richer handoffs (seamless
transitions, carried state) layer on top via the `portal:activate` event, which
a world can `preventDefault()` to take over.

### Multiplayer is presence, not game state

`multiplayer: true` connects the world to a relay (`workers/presence`) with one
Durable Object per world, keyed by the page's origin. Each visitor sends its
position, facing and expression about ten times a second, and the room forwards
it to everyone else. The relay keeps no game state and stores nothing, so it is
cheap: rooms with nobody in them hibernate and cost nothing. Rooms are capped
(16 per world, 64 for the hub lobby) so one busy world cannot use up the free
plan. A creator who needs more runs their own copy and passes `server`.

Physics, shared objects and other game state are not synced. The runtime is
shaped so a richer network layer can replace this one:

- the local player is fully described by a small serializable `PlayerState`, so
  a remote peer's state can drive an identical avatar with no changes to
  movement code;
- `update(dt)` is separate from rendering, so a fixed network tick can drive it;
- `Player` is a plain `Object3D` wrapper, so remote avatars instantiate the same
  way local ones do;
- nothing in movement, camera or portals reaches for a global connection;
- `NetworkAdapter` (in `src/net/adapter.ts`) is the seam. `Presence`
  (`src/net/presence.ts`) is the built-in implementation, and a world can pass
  its own as `network`.

Peer-to-peer WebRTC was considered and left out: it still needs a server to
introduce peers, relays some traffic anyway, does not scale past a handful of
people, and shows every visitor everyone else's IP address.

### The overlay lives in the runtime

The click-to-enter panel, the control legend, the crosshair, the interact
prompt and the WorldMesh badge are runtime-owned. If each world styled its own,
"navigation feels familiar everywhere" would last exactly one world. A world
can turn individual pieces off through `ui`.

## Deploying

Each app builds to its own static `dist/`. Any static host works. For Firebase
Hosting, each world is either its own site in one project or its own project;
the hub is just another static site. Nothing in the runtime assumes a
particular host, and no server code exists to deploy.

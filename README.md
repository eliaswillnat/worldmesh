# WorldMesh

A lightweight open network for independently hosted 3D worlds.

Anyone builds a 3D world, hosts it wherever they like, and pastes the URL into
WorldMesh. The worlds stay on their creators' own infrastructure. WorldMesh
supplies the one thing they need to share: **a navigation standard**, so that
moving through an unfamiliar world feels like moving through a familiar one.

```
Create world with AI  →  deploy it yourself  →  paste the URL into WorldMesh  →  done
```

## What WorldMesh hosts

| WorldMesh hosts | Creators host |
| --- | --- |
| the shared runtime (`@worldmesh/runtime`) | models, textures, environments |
| the world directory | world-specific logic |
| navigation conventions | large assets |
| the compatibility standard | their own multiplayer servers, if they need them |

## Status

MVP. It proves one thing: **five completely different, independently
deployable 3D websites can share exactly the same movement, camera and
navigation runtime.** Optional accounts (Google, Apple, GitHub, Discord) and a first
ActivityPub foundation, so creators can be followed from Mastodon as
`@name@worldmesh.net`, live in two small Workers beside the hub — see
[docs/accounts-and-federation.md](docs/accounts-and-federation.md). No moderation of
listed worlds yet. See [docs/roadmap.md](docs/roadmap.md).

The hub also has a **walk mode**: the directory
as a place. Every listed world is a doorway set into a round wall around a
mirrored grid, showing its cover, and walking into one travels there. The lobby is black or white depending on each visitor's own
light/dark setting. Everyone in
walk mode sees everyone else, through a tiny presence relay in
`workers/presence`. The screens on the towers around the lobby are billboards
anyone can book for €2, reviewed by hand before they go live (`workers/ads`,
see [docs/advertising.md](docs/advertising.md)).

## Repo layout

```
worldmesh/
├── packages/
│   └── runtime/        @worldmesh/runtime — controls, movement, camera,
│                       player, abilities, portals, overlay
├── workers/
│   ├── auth/           accounts: Better Auth + D1 (Google, Apple, GitHub, Discord)
│   ├── federation/     WebFinger + ActivityPub for creators
│   ├── ads/            paid billboard ads in walk mode: uploads, Stripe, moderation
│   └── …               presence, views, screenshot, notify
├── db/migrations/      the D1 schema both of them share
├── apps/
│   ├── hub/            the directory (port 5170)
│   ├── forest/         demo world     (5171)
│   ├── mars/           demo world     (5172)
│   ├── city/           demo world     (5173)
│   ├── medieval/       demo world     (5174)
│   └── space/          demo world     (5175)
└── docs/
```

Each app is a standalone Vite project with its own `dist/`. They are deployed
separately and know about each other only through URLs.

## Run it

```bash
npm install
```

That also builds `@worldmesh/runtime` into `packages/runtime/dist`, which is
what the apps import. If you are editing the runtime itself, keep
`npm run dev:runtime` running beside the dev server.

Then start the hub and as many worlds as you want, each in its own terminal:

```bash
npm run dev:hub
```

```bash
npm run dev:forest
```

Open <http://localhost:5170>. Portals between worlds assume all six dev servers
are running. To see other visitors in walk mode locally, also run
`npm run dev:presence`.

## Making a Three.js project WorldMesh-compatible

The runtime is packaged for npm — `npm i @worldmesh/runtime three` — but not
published yet, so for now clone this repo. See
[docs/publishing.md](docs/publishing.md).

If you already have a scene, a camera and a renderer, this is the whole job:

```js
import { createWorldMesh } from '@worldmesh/runtime';

createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 0],
  colliders,                    // things to stand on and bump into
  abilities: { doubleJump: true },
  portals: [{ url: 'https://someone-elses-world.example', position: [6, 0, -6] }],
});
```

You get WASD + arrow keys, mouse look, jump, sprint, interact, first/third
person with a consistent toggle, pointer-lock handling, the shared overlay and
portals. See [docs/compatibility.md](docs/compatibility.md) for the full option
reference and [docs/controls.md](docs/controls.md) for the control convention.

## Docs

- [Architecture](docs/architecture.md) — why it is shaped this way
- [Compatibility](docs/compatibility.md) — the world-facing contract
- [Controls](docs/controls.md) — the navigation convention
- [Accounts and federation](docs/accounts-and-federation.md) — login, D1, ActivityPub
- [Billboard advertising](docs/advertising.md) — paid, reviewed ads on walk mode's screens
- [Publishing](docs/publishing.md) — how the runtime is built and versioned
- [Roadmap](docs/roadmap.md) — what is deliberately not built yet

## License

MIT.

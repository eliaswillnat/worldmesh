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
navigation runtime.** Nothing else is built yet — no accounts, no database, no
multiplayer, no moderation. See [docs/roadmap.md](docs/roadmap.md).

## Repo layout

```
worldmesh/
├── packages/
│   └── runtime/        @worldmesh/runtime — controls, movement, camera,
│                       player, abilities, portals, overlay
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

Then start the hub and as many worlds as you want, each in its own terminal:

```bash
npm run dev:hub
```

```bash
npm run dev:forest
```

Open <http://localhost:5170>. Portals between worlds assume all six dev servers
are running.

## Making a Three.js project WorldMesh-compatible

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
- [Roadmap](docs/roadmap.md) — what is deliberately not built yet

## License

MIT.

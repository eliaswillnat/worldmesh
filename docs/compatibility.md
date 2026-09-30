# WorldMesh compatibility

A WorldMesh world is an ordinary web page that renders a Three.js scene and
calls `createWorldMesh` once. There is nothing else to implement, no account to
create, and no build tooling to adopt.

The runtime ships as an ESM package with `three` as a peer dependency:

```bash
npm i @worldmesh/runtime three
```

It is packaged but not on npm yet, so until it is, clone the repo and use the
workspace copy. See [publishing.md](publishing.md).

## Minimum viable world

```js
import { createWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

const scene = new Scene();
const camera = new PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 400);
const renderer = new WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

// ...build your world however you like...

createWorldMesh({ scene, camera, renderer, spawn: [0, 2, 0] });
```

That gets you the full control convention, both camera modes, the shared
overlay, gravity, jumping and respawning.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `scene`, `camera`, `renderer` | required | Your own, untouched. |
| `spawn` | `[0, 2, 0]` | Feet position, not eye position. |
| `colliders` | `[]` | Meshes to stand on and bump into. Pass a function if geometry is built lazily. |
| `groundLevel` | `0` | Flat floor height used only when `colliders` is empty. |
| `abilities` | all `false` | See below. |
| `portals` | `[]` | See below. |
| `player` | 1.8m tall, 0.35m radius | `avatar` replaces the default white figure, `avatar: false` removes it. |
| `avatar` | off | `{ source: 'worldmesh' }` shows the visitor's Avatar Wallet character (VRM/glTF, loaded from the platform that hosts it); `{ source: 'descriptor', descriptor }` loads one you resolved yourself. Falls back to the default body. See [avatar-wallet.md](avatar-wallet.md). |
| `view` | `{ mode: 'first', distance: 5 }` | Starting camera mode, boom length, mouse sensitivity, initial `yaw`/`pitch`. |
| `movement` | see `DEFAULT_TUNING` | `gravity`, `walkSpeed`, `jumpSpeed`, `fallLimit`, … |
| `keymap` | the convention | Add bindings; do not move the core row. |
| `ui` | all on | `title`, `hubUrl`, `crosshair`, `badge`, `controlsHint`. |
| `autoStart` | `true` | `false` if you drive your own loop. |
| `autoResize` | `true` | `false` if the canvas is not full-window. |
| `onUpdate` | — | `(dt, world) => void`, after movement, before render. |

## Abilities

Declared, never re-implemented:

```js
abilities: {
  doubleJump: false,
  flying: false,
  crouching: false,
  dash: false,
  // reserved, not implemented yet:
  climbing: false,
  swimming: false,
  vehicles: false,
}
```

## Portals

```js
portals: [
  {
    url: 'https://another-creators-world.example',
    label: 'Their World',     // defaults to the destination host
    position: [6, 0, -6],
    radius: 2,                // trigger radius
    mode: 'interact',         // 'interact' (press E) or 'auto' (walk through)
    color: 0x6cf0ff,
    visual: false,            // to supply your own portal geometry
  },
]
```

Entering a portal navigates to the destination with a `?from=` parameter
carrying the origin world. Read it with `getReferringWorld()`.

To take over the transition yourself:

```js
world.on('portal:activate', (event) => {
  event.preventDefault();
  playFadeOut().then(() => world.travelTo(event.url));
});
```

## The handle

`createWorldMesh` returns:

```ts
world.update(dt)            // step the simulation without rendering
world.start() / stop()      // control the built-in loop
world.getState()            // serializable PlayerState
world.setState(partial)
world.teleport([x, y, z], yaw?)
world.respawn()
world.setViewMode('first' | 'third')
world.addPortal(portal)
world.travelTo(url)
world.loadAvatar(descriptor) // external VRM/glTF body; resolves false and keeps the default on failure
world.clearAvatar()
world.refreshColliders()    // after adding geometry
world.on(event, fn)         // returns an unsubscribe function
world.dispose()
```

Events: `update`, `portal:enter`, `portal:exit`, `portal:activate`,
`view:change`, `pointer:lock`, `interact`, `respawn`, `avatar:load`,
`avatar:error`.

## The manifest

Optional, and intentionally tiny. Serve it at `/worldmesh.json`, or at
`/.well-known/worldmesh.json` if you prefer:

```json
{
  "worldmesh": 1,
  "name": "Forest",
  "description": "A quiet pine clearing with a few things worth climbing.",
  "author": "you",
  "spawn": [0, 2, 8],
  "abilities": { "doubleJump": true },
  "portals": [{ "label": "Mars", "url": "https://mars.example/" }]
}
```

The hub reads it when you paste a URL so it can show a name and description.
A world without a manifest works exactly the same; it just shows up under its
hostname. Serve it with `Access-Control-Allow-Origin: *` if you want the hub to
be able to read it.

## What compatibility does *not* require

No WorldMesh account. No build plugin. No asset upload. No SDK beyond one
import. No server. Your world stays entirely on your hosting, and removing the
`createWorldMesh` call leaves you with the Three.js project you started with.

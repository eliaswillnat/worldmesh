# @worldmesh/runtime

The shared [WorldMesh](https://github.com/eliaswillnat/worldmesh) navigation
runtime: controls, movement, camera, player, abilities and portals.

WorldMesh is a lightweight open network for independently hosted 3D worlds. It
supplies the one thing separately hosted worlds need in common — a navigation
standard — so that moving through an unfamiliar world feels like moving through
a familiar one. This package is that standard, as code.

## Install

```bash
npm i @worldmesh/runtime three
```

`three` is a peer dependency (`>=0.160.0`): the runtime drives your renderer,
your scene and your camera, so it must use the same copy of Three.js you do.

The package is ESM only and targets ES2022 browsers. It touches `window` and
`document` when you create a world, so call it from the browser, not during SSR.

## Use it

If you already have a scene, a camera and a renderer, this is the whole job:

```js
import { createWorldMesh } from '@worldmesh/runtime';

const world = createWorldMesh({
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
person with a consistent toggle, pointer-lock handling, touch controls on touch
devices, the shared overlay and portals between worlds.

Removing the `createWorldMesh` call leaves you with the Three.js project you
started with.

## What is exported

| | |
| --- | --- |
| `createWorldMesh` | the one call a world needs |
| `Input`, `TouchControls`, `DEFAULT_KEYMAP`, `resolveKeymap` | the control convention |
| `MovementController`, `CollisionWorld`, `DEFAULT_TUNING` | movement and collision |
| `CameraRig`, `Player`, `createDefaultAvatar`, `AVATAR_EXPRESSIONS` | camera and figure |
| `PortalManager`, `buildTravelUrl`, `getReferringWorld` | travel between worlds |
| `Overlay`, `Emitter` | the shared overlay, a tiny typed emitter |
| `serializePlayerState`, `deserializePlayerState`, `NetworkAdapter` | the multiplayer seam |
| `WORLDMESH_VERSION`, `WORLDMESH_PROTOCOL` | what your world is speaking |

Full option, handle and event reference:
[docs/compatibility.md](https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md).
Control convention:
[docs/controls.md](https://github.com/eliaswillnat/worldmesh/blob/main/docs/controls.md).

## Versions

`WORLDMESH_VERSION` tracks this package's version. `WORLDMESH_PROTOCOL` is a
separate integer that only changes when the world-facing contract changes in a
way a world would have to react to — see
[docs/publishing.md](https://github.com/eliaswillnat/worldmesh/blob/main/docs/publishing.md).

```js
import { WORLDMESH_PROTOCOL } from '@worldmesh/runtime';
```

## License

MIT

# @worldmesh/runtime

The shared [WorldMesh](https://github.com/eliaswillnat/worldmesh) navigation
runtime: controls, movement, camera, player, abilities and portals.

WorldMesh is an open network for independently hosted 3D worlds, connected across the web. It
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
import { loadWorldMesh } from '@worldmesh/runtime';

const world = await loadWorldMesh({
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
devices, immersive VR through the shared Enter VR control when WebXR is
available, the shared overlay and portals between worlds.

Removing the `loadWorldMesh` call leaves you with the Three.js project you
started with.

## Staying current

`loadWorldMesh` runs the current runtime from worldmesh.net, with your copy of
Three.js, so fixes and improvements reach your world without a rebuild. If it
cannot be loaded, the copy in this package runs instead (in its own chunk,
downloaded only then). `createWorldMesh` takes the same options and always
runs the copy in this package, synchronously. Details:
[Staying current](https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md#staying-current-loadworldmesh-and-createworldmesh).

## Visitors' own avatars (optional)

```js
loadWorldMesh({ scene, camera, renderer, avatar: { source: 'worldmesh' } });
```

Visitors who picked a character in their WorldMesh Avatar Wallet (Sketchfab,
VRoid Hub, at3d) arrive with a short-lived ticket in the URL fragment. The runtime removes
it from the address bar, asks the hub for a descriptor, and loads the VRM or
glTF straight from the platform that hosts it. Portals carry the ticket on.
Without a ticket, or if anything fails, the player keeps the default body.
Your world never receives the visitor's account, session or platform tokens.

Already have a model URL? Pass `avatar: { source: 'descriptor', descriptor }`,
or call `world.loadAvatar(descriptor)` / `world.clearAvatar()` at any time.
`avatar:load` and `avatar:error` events report the outcome. The VRM and glTF
loaders (`@pixiv/three-vrm`) are only downloaded when an avatar is shown.

## Your own multiplayer backend (optional)

`multiplayer: true` uses the WorldMesh presence relay. A world on Nakama,
Colyseus, PartyKit, Supabase Realtime, Ably or a WebSocket server of its own
passes a `NetworkAdapter` as `network` instead, and nothing goes through
WorldMesh's servers. The runtime calls its `attach`, `bodies` and `detach`; the
adapter listens to `update` for the visitor's state and draws everyone else.
Guide, a complete example and what the relay does that you then do yourself:
[Your own network layer](https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md#your-own-network-layer).

## Live doors

A hub door can show your world itself, live, as seen from the visitor's own
camera: water moving, everything as it is. Publish a Doorway file at
`/.well-known/doorway.json` saying `{ "doorway": 1, "view": true }` and let
hubs frame your page. The hub opens it with `?doorway-view` and sends its
camera every frame; the runtime does the rest: no UI, no input, drawing only
the doorway's part of the screen from that camera, carried onto your spawn
point (Doorway spec §3.1). With `multiplayer: true` the view watches your
world's room, so the people inside show through the doorway, in their own
avatars, while nobody sees the visitor and they take no one's place. Hubs keep the
cover for worlds without it.

Add `"embed": true` (and `"characters": ["vrm", "glb"]` if you show
visitors' avatars) and visitors can walk straight in: as they cross the
doorway the hub hands over their pose, and the same page takes over the
screen, online, with no reload (§4). While inside, `travelTo` asks the hub to
open other pages, as the page around your world is the hub's.

## What is exported

| | |
| --- | --- |
| `loadWorldMesh` | the one call a world needs, kept current |
| `createWorldMesh`, `HOSTED_RUNTIME_URL` | the same call on the copy in this package; where `loadWorldMesh` loads from |
| `Input`, `TouchControls`, `DEFAULT_KEYMAP`, `resolveKeymap` | the control convention |
| `MovementController`, `CollisionWorld`, `DEFAULT_TUNING` | movement and collision |
| `CameraRig`, `Player`, `createDefaultAvatar`, `AVATAR_EXPRESSIONS` | camera and figure |
| `PortalManager`, `buildTravelUrl`, `getReferringWorld` | travel between worlds |
| `loadAvatarModel`, `resolveWorldMeshAvatar`, `parseAvatarDescriptor`, `AvatarDescriptor` | visitors' own avatars |
| `Overlay`, `Emitter` | the shared overlay, a tiny typed emitter |
| `immersiveVrSupported`, `requestImmersiveVr` | the shared WebXR enter-VR path |
| `Presence`, `DEFAULT_PRESENCE_SERVER`, `NetworkAdapter` | multiplayer (`multiplayer: true`) and the seam for your own |
| `createNameTag`, `createSpeechBubble`, `easeYaw`, `createShareVerifier` | drawing other people, and checking their avatar links, in a network layer of your own |
| `DOORWAY_VIEW_PARAM` | a hub drawing your world live in its doorway (`?doorway-view`), from the visitor's camera; walked into, it takes over from their exact pose, goes online without reloading, and asks the hub to open any other page |
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

# Connect a 3D world to WorldMesh

These instructions are for an AI coding agent working in a creator's web
project. Follow them in order. Ask the creator only where a step says to.

WorldMesh links independently hosted 3D worlds. A connected world gets the
shared WorldMesh controls (WASD, mouse look, jump, first/third person, touch),
portals to other worlds, and multiplayer: visitors see each other. The world
stays on the creator's own hosting. No WorldMesh account or server is needed.

## 1. Check the project

- **Three.js** (directly, or through a framework such as Vite, Next.js or
  React Three Fiber): continue.
- **Anything else** (Babylon.js, PlayCanvas, Unity, Godot, Unreal, A-Frame):
  stop. The WorldMesh runtime only supports Three.js. Tell the creator they
  can still submit the world at https://worldmesh.net if it uses the standard
  controls in step 4, but it will not get WorldMesh multiplayer or portals.

## 2. Install

With a package manager:

```bash
npm i @worldmesh/runtime three
```

`three` is a peer dependency (version 0.160 or newer). The runtime must use
the same copy of Three.js as the world, so do not add a second one.

Without a bundler (plain HTML with `<script type="module">`), use an import
map so both resolve to the same Three.js:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://esm.sh/three@0.169.0",
    "@worldmesh/runtime": "https://esm.sh/@worldmesh/runtime@0.2?external=three"
  }
}
</script>
```

If the page already loads Three.js from a URL, map `"three"` to that URL
instead.

## 3. Connect

Call `createWorldMesh` once, in the browser, after the scene, camera and
renderer exist and the level geometry has been added:

```js
import { createWorldMesh } from '@worldmesh/runtime';

const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 0],      // where visitors appear: feet position, above the floor
  colliders: [ground, ...walls], // meshes to stand on and bump into
  multiplayer: true,     // visitors see each other
});
```

- `spawn`: pick a clear spot above the floor, near the world's main view.
- `colliders`: the meshes a player should walk on and not walk through
  (floors, terrain, buildings, rocks). Leave out decoration such as grass,
  particles and sky. If geometry loads asynchronously (GLTF), pass a function
  `colliders: () => [...]` and call `world.refreshColliders()` after it loads.
  With no colliders, the player walks on a flat floor at `groundLevel` (0).
- The runtime runs the render loop and handles window resizing. Remove the
  project's own `requestAnimationFrame` render loop and resize handler, and
  move per-frame logic into `onUpdate: (dt, world) => { ... }`.

**React Three Fiber:** create the world inside a component, let R3F keep
rendering, and step WorldMesh from `useFrame`:

```jsx
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { createWorldMesh } from '@worldmesh/runtime';

function WorldMesh({ colliders }) {
  const { scene, camera, gl } = useThree();
  const world = useRef(null);
  useEffect(() => {
    world.current = createWorldMesh({
      scene, camera, renderer: gl,
      colliders, spawn: [0, 2, 0], multiplayer: true,
      autoStart: false, autoResize: false,
    });
    return () => world.current.dispose();
  }, [scene, camera, gl]);
  useFrame((_, dt) => world.current?.update(dt));
  return null;
}
```

In Next.js or any server-rendered app, only create the world on the client
(inside `useEffect`, or a component loaded with `ssr: false`).

## 4. Remove conflicting controls

WorldMesh owns the camera and input. Remove or disable the project's own:

- `OrbitControls`, `PointerLockControls`, `FirstPersonControls`,
  `FlyControls`, or similar camera controls;
- keyboard and mouse handlers for moving the player or camera;
- custom player physics that moves the camera.

Keep world-specific interactions. Bind them to keys WorldMesh does not use
(WorldMesh uses WASD, the arrow keys, the mouse, Space, Shift, C, E, F, Q, V, Esc and 1–9), or
listen for `world.on('interact', ...)`, which fires when the visitor presses E.

## 5. Optional extras

Ask the creator before adding these.

- **Portals** to other worlds:
  `portals: [{ url: 'https://other-world.example', position: [6, 0, -6] }]`
- **Abilities:**
  `abilities: { doubleJump: true, flying: false, crouching: false, dash: false }`
- **Manifest:** a file at `/worldmesh.json` that gives the world a name on the
  hub. Serve it with the header `Access-Control-Allow-Origin: *`.

  ```json
  {
    "worldmesh": 1,
    "name": "World name",
    "description": "One sentence about the world.",
    "author": "creator name",
    "spawn": [0, 2, 0]
  }
  ```

## 6. Check it works

Run the dev server and open the world:

1. A WorldMesh panel with a **Continue** button appears. Click it.
2. WASD moves, the mouse looks around, Space jumps, V switches between first
   and third person.
3. The player stands on the floor, does not fall through it, and cannot walk
   through walls. If the player falls forever, the floor is missing from
   `colliders`. Falling off the world respawns at `spawn`.
4. Open the same page in a second browser window. Each window shows the other
   visitor as a figure.

Multiplayer needs the page to load from `http://` or `https://`. It does not
work from a `file://` URL. If the relay cannot be reached, the world keeps
working single-player.

## 7. Publish

Deploy the world as usual. Then tell the creator to submit its public URL
with the **Submit world** form at https://worldmesh.net. Submissions are
reviewed before they appear on the hub.

## Rules

- Multiplayer rooms hold 16 people. Creators who need more can run their own
  relay: deploy `workers/presence` from
  https://github.com/eliaswillnat/worldmesh and pass
  `multiplayer: { server: 'wss://their-relay.example' }`.
- Using WorldMesh means agreeing to https://worldmesh.net/terms.html. The
  privacy policy at https://worldmesh.net/privacy.html explains what
  multiplayer shares between visitors.

Full reference: https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md

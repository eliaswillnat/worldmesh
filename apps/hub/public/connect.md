# Connect a 3D world to WorldMesh

These instructions are for an AI coding agent working in a creator's web
project. Follow them in order. Ask the creator only where a step says to.

WorldMesh links independently hosted 3D worlds. A connected world gets the
shared WorldMesh controls (WASD, mouse look, jump, first/third person, touch),
visitors' own avatars (the character they picked once on WorldMesh follows
them from world to world, with no sign-up in each world), portals to other
worlds, and multiplayer: visitors see each other. The world stays on the
creator's own hosting.

## Ground rules

- **Work locally.** You are working in the creator's project as it is on
  their computer. It may be a private repository; that is fine. You do not
  need GitHub access, a pull request, or a WorldMesh account. Do not commit,
  push or open a pull request unless the creator asks you to.
- **Keep what works.** Preserve the creator's gameplay, controls, rendering
  and multiplayer wherever you can. Change only what the integration needs,
  and ask before removing or replacing a system the creator built.
- **WorldMesh does not pay for this world's multiplayer.** Do not use
  `multiplayer: true`: it points at the relay WorldMesh runs for its own
  spaces. Use the creator's existing multiplayer, or a relay on the creator's
  own hosting (step 6).
- **Ask the creator before you:** remove or replace their controls, player,
  physics or multiplayer; create or sign in to any account; add a paid
  service; deploy anything; change their hosting or security headers.
- **Be honest.** If a step cannot be done safely, stop that step, leave the
  project working, and list what is left (step 9). Never say the integration
  works if you have not checked it.

## 1. Inspect the project

Before changing anything, find out and note:

- the engine and framework (Three.js directly, React Three Fiber, Vite,
  Next.js, plain HTML, something else) and the Three.js version;
- where the scene, camera and renderer are created, and who runs the render
  loop and handles window resizing;
- how the player moves: camera controls, a character controller, physics
  (Rapier, cannon-es, ammo.js, custom), or none;
- any existing multiplayer (Socket.IO, Colyseus, PartyKit, Liveblocks,
  Supabase Realtime, WebRTC, a custom WebSocket server), and where it sends
  and draws player positions;
- how the project is built, tested and deployed, and its security headers
  (`Content-Security-Policy`);
- whether the project builds and runs now. If it does not, tell the creator
  before you start, so a broken build is not blamed on WorldMesh.

## 2. Choose the path

- **Three.js** (directly, or through Vite, Next.js or similar): continue.
- **React Three Fiber:** continue, and use the R3F variant in step 4.
- **Anything else** (Babylon.js, PlayCanvas, A-Frame, Unity, Godot, Unreal,
  Spline, a game engine's web export): the WorldMesh runtime only
  supports Three.js, so the world cannot get WorldMesh multiplayer, avatars or
  portals today. Plain links to other worlds still work. Do not try to embed a second engine. What you can do:
  1. make the world's controls match the convention in step 5 (WASD or arrow
     keys, mouse look, Space to jump, Shift to sprint, E to interact);
  2. add the manifest from step 7;
  3. tell the creator they can submit the world at https://worldmesh.net so
     it is listed, and that full support for their engine is not available yet.
  Then go to step 9.

If the world already has its own first- or third-person player (its own
character controller, physics or camera logic that gameplay depends on), ask
the creator before step 4. WorldMesh takes over the camera and movement, so
explain the trade-off and offer the choice:

- **Full connection:** WorldMesh's controls replace theirs, and the world gets
  multiplayer, avatars and portals. Gameplay that reads the player's position
  is moved onto `world.getState()` and the WorldMesh events.
- **Listing only:** keep their controls untouched, align the keys with step 5,
  and add the manifest. No runtime. The world can be listed on WorldMesh.

## 3. Install

With a package manager:

```bash
npm i @worldmesh/runtime three
```

`three` is a peer dependency (version 0.160 or newer). The runtime must use
the same copy of Three.js as the world, so do not add a second one. If the
project already depends on `three`, keep its version.

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

## 4. Connect

Call `createWorldMesh` once, in the browser, after the scene, camera and
renderer exist and the level geometry has been added:

```js
import { createWorldMesh } from '@worldmesh/runtime';

const world = createWorldMesh({
  scene,
  camera,
  renderer,
  spawn: [0, 2, 0],              // where visitors appear: feet position, above the floor
  colliders: [ground, ...walls], // meshes to stand on and bump into
  avatar: { source: 'worldmesh' }, // visitors arrive as their WorldMesh character
  // multiplayer: see step 6
});
```

- `spawn`: pick a clear spot above the floor, near the world's main view.
- `colliders`: the meshes a player should walk on and not walk through
  (floors, terrain, buildings, rocks). Leave out decoration such as grass,
  particles and sky. If geometry loads asynchronously (GLTF), pass a function
  `colliders: () => [...]` and call `world.refreshColliders()` after it loads.
  With no colliders, the player walks on a flat floor at `groundLevel` (0).
- `avatar: { source: 'worldmesh' }`: visitors who picked a character on
  WorldMesh arrive as it (its name is in `world.avatarDescriptor?.name`).
  Everyone else gets the default figure. Other visitors still see the default
  figure for now. The model downloads from the platform that hosts it
  (VRoid Hub, Sketchfab, at3d), so if the project sets a
  `Content-Security-Policy`, its `connect-src` must allow `https:` (or those
  hosts) and `https://worldmesh.net`. Ask the creator before changing it.
- **Render loop:** by default the runtime runs the render loop and handles
  window resizing. If the project has its own loop that also does other work
  (post-processing, animation mixers, game logic), keep it: pass
  `autoStart: false, autoResize: false`, call `world.update(dt)` from that
  loop before it renders, and leave its resize handler. Otherwise remove the
  project's `requestAnimationFrame` loop and resize handler, and move
  per-frame logic into `onUpdate: (dt, world) => { ... }`.

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
      colliders, spawn: [0, 2, 0],
      avatar: { source: 'worldmesh' },
      autoStart: false, autoResize: false,
    });
    return () => world.current.dispose();
  }, [scene, camera, gl]);
  useFrame((_, dt) => world.current?.update(dt));
  return null;
}
```

Mount `<WorldMesh />` inside the `<Canvas>`, after the level has loaded.
In Next.js or any server-rendered app, only create the world on the client
(inside `useEffect`, or a component loaded with `ssr: false`).

## 5. Remove conflicting controls

WorldMesh owns the camera and movement. Only after the creator agreed (step
2), remove or disable the project's own:

- `OrbitControls`, `PointerLockControls`, `FirstPersonControls`,
  `FlyControls`, drei's `<OrbitControls>` / `<PointerLockControls>`, or
  similar camera controls;
- keyboard and mouse handlers for moving the player or camera;
- custom player physics that moves the camera.

Comment out or delete only those pieces, so everything else keeps working.
Keep world-specific interactions. Bind them to keys WorldMesh does not use
(WorldMesh uses WASD, the arrow keys, the mouse, Space, Shift, C, E, F, Q, V,
Esc and 1–9), or listen for `world.on('interact', ...)`, which fires when the
visitor presses E. Gameplay that needs the player's position reads
`world.getState().position`.

## 6. Multiplayer

WorldMesh does not host multiplayer for this world. Pick the first case that
fits.

**a. The world already has multiplayer.** Keep it. Do not turn on WorldMesh
multiplayer as well, or visitors will see everyone twice. The code that sent
the old player's position must now send WorldMesh's player instead. The
simplest way is a small adapter that hands the player's state to the existing
client; the world's own code keeps drawing the other players:

```js
let stopSending = () => {};
const world = createWorldMesh({
  scene, camera, renderer,
  network: {
    attach(world) {
      let last = 0;
      stopSending = world.on('update', ({ state }) => {
        const now = performance.now();
        if (now - last < 100) return; // keep the project's own send rate
        last = now;
        // state.position [x, y, z], state.facing, state.onGround, state.velocity
        myExistingClient.sendPlayer(state); // whatever the project already calls
      });
    },
    detach() { stopSending(); },
  },
});
```

Map `state` onto the message shape the project already uses, and keep its
server, rooms and accounts as they are.

**b. No multiplayer yet, and the creator wants it.** Set up the WorldMesh
relay on the creator's own Cloudflare account. It is a small Cloudflare
Worker that passes positions between visitors and stores nothing. It runs on
Cloudflare's free Workers plan, where traffic over the free limits is refused
rather than billed. This needs the creator to have (or create) a Cloudflare
account and approve the deploy, even if the world itself is hosted
elsewhere (Vercel, Netlify, GitHub Pages, their own server). Ask first, then:

```bash
# The WorldMesh repository is public: no GitHub account needed.
git clone --depth 1 https://github.com/eliaswillnat/worldmesh.git /tmp/worldmesh
cp -r /tmp/worldmesh/workers/presence ./worldmesh-relay
cd worldmesh-relay
npx wrangler login         # the creator signs in to Cloudflare in their browser
npx wrangler deploy --env=""
```

- Before deploying, change `name` in `worldmesh-relay/wrangler.toml` to
  something of the creator's, such as `my-world-relay`, and delete the
  `[env.preview]` sections (they are WorldMesh's own).
- Make sure the app's TypeScript, lint and build settings do not pick up the
  `worldmesh-relay` folder (add it to their `exclude` lists if needed).
- `wrangler deploy` prints the Worker's address, such as
  `https://my-world-relay.<their-subdomain>.workers.dev`. Use it with `wss://`:

  ```js
  multiplayer: { server: 'wss://my-world-relay.their-subdomain.workers.dev' },
  ```

- Rooms hold 16 people. The creator can raise `MAX_WORLD_PEERS` in
  `worldmesh-relay/src/index.ts`.

If the creator does not want to do this now, or you cannot run `wrangler`,
leave multiplayer off, write the line above as a comment, and list the steps
for the creator in step 9.

**c. The creator does not want multiplayer.** Leave `multiplayer` and
`network` out. Everything else still works.

## 7. Optional extras

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

- **Walk straight in from WorldMesh:** where supported, the hub can show the
  world live in its door and let visitors step in without a page load. Serve
  `/.well-known/doorway.json` with `Access-Control-Allow-Origin: *`:

  ```json
  { "doorway": 1, "view": true, "embed": true, "characters": ["vrm", "glb"] }
  ```

  and let the hub frame the page with the header
  `Content-Security-Policy: frame-ancestors 'self' https://worldmesh.net`.
  The runtime handles the rest. This changes hosting headers, so the creator
  must approve it. Spec: https://github.com/eliaswillnat/worldmesh/blob/main/docs/specs/doorway.md

## 8. Check it works

Run the project's own build, typecheck, lint and tests, as they ran before
step 3, and fix anything the integration broke. Then run the dev server and
open the world:

1. A WorldMesh panel with a **Continue** button appears. Click it.
2. WASD moves, the mouse looks around, Space jumps, V switches between first
   and third person.
3. The player stands on the floor, does not fall through it, and cannot walk
   through walls. If the player falls forever, the floor is missing from
   `colliders`. Falling off the world respawns at `spawn`.
4. The world's own gameplay, interactions, sound and visuals still work.
5. With multiplayer (step 6a or 6b): open the same page in a second browser
   window. Each window shows the other visitor.

If you cannot open a browser, say so, and give the creator these checks to do.

Multiplayer needs the page to load from `http://` or `https://`. It does not
work from a `file://` URL. If the relay cannot be reached, the world keeps
working single-player.

## 9. Report back

Finish with a short, plain summary for the creator. No jargon. Include:

- **Done:** what changed, in which files.
- **Checked:** what you ran and saw working, and what you could not check.
- **Kept:** the creator's systems you left in place.
- **Still to do,** each with who does it and why:
  - decisions only the creator can make (replacing controls, extras);
  - accounts they must create or sign in to (Cloudflare for the relay);
  - deploying the world and the relay to their hosting;
  - anything you could not finish safely, and how to finish it.
- **Last step:** after the world is deployed, submit its public URL with
  **Submit world** at https://worldmesh.net. Submissions are reviewed before
  they appear on the hub.

## Rules

- Using WorldMesh means agreeing to https://worldmesh.net/terms. The
  privacy policy at https://worldmesh.net/privacy explains what
  multiplayer shares between visitors. A creator who runs their own relay is
  responsible for it.

Full reference: https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md

# WorldMesh compatibility

A WorldMesh world is an ordinary web page that renders a Three.js scene and
calls `loadWorldMesh` (or `createWorldMesh`) once. There is nothing else to implement, no account to
create, and no build tooling to adopt.

The runtime ships as an ESM package with `three` as a peer dependency:

```bash
npm i @worldmesh/runtime three
```

## Minimum viable world

```js
import { loadWorldMesh } from '@worldmesh/runtime';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

const scene = new Scene();
const camera = new PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 400);
const renderer = new WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

// ...build your world however you like...

const world = await loadWorldMesh({ scene, camera, renderer, spawn: [0, 2, 0] });
```

That gets you the full control convention, both camera modes, the shared
overlay, gravity, jumping and respawning.

## Staying current: `loadWorldMesh` and `createWorldMesh`

Both take the same options and give the same handle.

- **`loadWorldMesh(options)`** resolves to the world once the current runtime
  has loaded from `https://worldmesh.net/runtime/1/index.js` (the `1` is
  `WORLDMESH_PROTOCOL`). That runtime uses your copy of Three.js, so fixes and
  improvements reach your world the next time someone opens it, with no
  rebuild. If it cannot be loaded within 8 seconds, is blocked (for example by
  your Content Security Policy), speaks another protocol, or throws while
  starting, the copy installed with the package runs instead, and the console
  says why. Your bundler puts that copy in a separate chunk, downloaded only
  then. Using it costs one thing: your bundle includes all of Three.js rather
  than the parts you import, because the runtime may use any of it.
- **`createWorldMesh(options)`** returns the world straight away and always
  runs the installed copy: the runtime your world was built with, until you
  update the package and rebuild.

`loadWorldMesh` takes a second argument:

| Option | Default | Notes |
| --- | --- | --- |
| `url` | `HOSTED_RUNTIME_URL` | Another copy to run, e.g. one you host yourself. |
| `timeoutMs` | `8000` | How long to wait for it before using the installed copy. |
| `hosted` | `true` | `false` runs the installed copy, like `createWorldMesh`. |

Only `loadWorldMesh` itself is kept current. Everything else the package
exports (`Presence`, `createNameTag`, …) is the installed version.

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
| `multiplayer` | off | `true` shows everyone else in your world through the relay WorldMesh hosts; `{ server: 'wss://…' }` uses your own. See below. |
| `network` | — | Your own multiplayer backend instead of the relay; replaces `multiplayer`. See [Your own network layer](#your-own-network-layer). |
| `vr` | on | Shows **Enter VR** and calls `navigator.xr.requestSession('immersive-vr')` when the headset browser supports it. `false` hides the control. |
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

## Multiplayer

```js
createWorldMesh({ scene, camera, renderer, multiplayer: true });
```

Everyone on your world's page sees everyone else as a figure that walks,
turns and pulls faces. Visitors are anonymous guests. Positions go through a
small relay (`workers/presence`): the relay passes them along and stores
nothing.

- **One room per world.** The relay picks the room from the page's origin
  (`https://forest.example`), so there is nothing to register and another
  site cannot join your room from a browser. Different pages on the same
  origin share one room.
- **The hosted relay is free, within limits.** WorldMesh pays for it so
  small worlds can try multiplayer without a server. Its limits:
  - **16 people per world** at once (64 in the hub lobby, which has its own
    relay). Visitors past that see a full-screen “World is full” / “Lobby is
    full” overlay instead of joining silently alone.
  - **240 active minutes per world per day** (UTC). Minutes count only while
    someone in the room is moving; empty rooms and people standing still
    count nothing. Past that, people already in the world stay, new visitors
    are single-player until 00:00 UTC, and the console says why.
  - **Rate limits per IP address** on joining and on occupancy reads.
  - WorldMesh can block a world that misuses the relay, and may change these
    limits ([terms](https://worldmesh.net/terms)).
- **Your own relay.** Busy worlds, and independent cities, run their own.
  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaswillnat/worldmesh/tree/main/templates/relay)
  puts [`templates/relay`](../templates/relay) on your own Cloudflare account
  in one click: the same code, with no daily limit, and every limit a var
  (`MAX_WORLD_PEERS`, `WORLD_DAILY_MINUTES`, …). Then pass
  `multiplayer: { server: 'wss://worldmesh-relay.<your-subdomain>.workers.dev' }`.
  The traffic and cost are then yours. Without the button:
  `npm create cloudflare@latest my-relay -- --template=eliaswillnat/worldmesh/templates/relay`,
  then `npx wrangler deploy` in `my-relay`.
- **Offline is fine.** If the relay cannot be reached the world stays
  single-player.

`world.on('players', ({ count }) => …)` reports how many people are in the
room, including the visitor (`null` while disconnected). To network the world
some other way, pass your own `NetworkAdapter` as `network`.

## Your own network layer

A world that already runs a multiplayer backend (Nakama, Colyseus, PartyKit,
Supabase Realtime, Ably, a WebSocket server of its own…) can use it instead of
the presence relay. Pass a `NetworkAdapter` as `network`: `multiplayer` is then
ignored, and nothing goes through WorldMesh's servers.

```ts
interface NetworkAdapter {
  attach(world: WorldMeshHandle): void; // once, when the world goes online
  bodies?(): Iterable<PeerBody>;        // where everyone else stands, asked every step
  detach?(): void;                      // from world.dispose()
}
```

The runtime calls only these three. (`sendLocalState` and `onRemoteState` are
in the type too, as names for the adapter's own use; the runtime never calls
them.) The rest is the adapter's:

- **The visitor.** In `attach`, listen to
  `world.on('update', ({ dt, state }) => …)`. It fires every frame, after
  movement, with the visitor's `PlayerState`: `position` (feet), `facing` (the
  body's yaw), `onGround`, `flying`, `crouching`, `expression`, `velocity`, and
  the camera's `yaw` and `pitch`. Send what others need, at most about 10 times
  a second (as the relay does), and nothing while the visitor stands still.
- **Everyone else.** Add a figure to `world.scene` when someone first shows up,
  ease it toward each position they report, animate it, and remove and dispose
  of it when they leave. Return where they stand from `bodies()` (feet
  position, 0.35 m radius, 1.8 m tall, as the relay does) and the visitor walks
  into them rather than through them. The relay client's own pieces are
  exported: `createDefaultAvatar`, `animateDefaultAvatar`,
  `setAvatarExpression`, `setFigureStroke`, `createNameTag`,
  `createSpeechBubble` and `easeYaw`.
- **Joins and leaves.** Someone who joins later has heard nothing from people
  standing still, so answer a join by sending your state again. When the
  connection drops, remove everyone and reconnect in the background; the world
  stays single-player meanwhile.
- **Strangers' data.** Check the shape of everything that arrives, and that
  numbers are finite, before using it.
- **When to connect.** In a hub's live doorway the world runs offline, and
  `attach` is called only once the visitor walks in. Connect in `attach`, not
  when your module loads.

### Other people's avatars, safely

With `avatar: { source: 'worldmesh' }`, `world.getSharedAvatar()` is the link
other people may download the visitor's avatar from: signed by the hub, and
renewed by the runtime before it expires. It is null for the default body and
for avatars that may not be shown to others (VRoid Hub). Send it as it is, and
again whenever it changes.

When someone else's link arrives, download the model only if the hub signed
it. A link anyone made up could point at a server that logs the IP address of
everyone in the room.

1. `parseAvatarShare(value)` checks its shape (null if wrong).
2. Skip it if it has expired: `x` is in Unix seconds.
3. `await createShareVerifier(hubUrl)(share)` checks the hub's signature. Use
   the same hub as `avatar.hubUrl` (`https://worldmesh.net/` by default). It
   throws while the hub's key cannot be fetched; the relay client tries again a
   minute later.
4. Only then `loadAvatarModel(…)`, with a `maxBytes` limit.

Never send, or load, a plain `modelUrl`.

### Example: a pub/sub WebSocket backend

[`examples/pubsub-network.ts`](examples/pubsub-network.ts) is a complete
adapter for a server that only relays: each message goes to everyone else in
the same room with the sender's id added as `from`, and the server says `join`
and `leave` itself. On the wire, as JSON:

```js
{ t: 'pose', p: [x, y, z], r: facing, e: expression, g: 1 } // while moving, up to 10 a second
{ t: 'avatar', share }                                       // world.getSharedAvatar(), when it changes
{ t: 'join', from }, { t: 'leave', from }                    // from the server
```

```js
import { PubSubNetwork } from './pubsub-network.js';

createWorldMesh({
  scene, camera, renderer,
  avatar: { source: 'worldmesh' },
  network: new PubSubNetwork('wss://rooms.example/forest'),
});
```

It sends the visitor's pose and avatar from `update`, answers `join` by
sending them again, draws everyone else in the default figure with a name tag
(their own avatar once its link checks out), eases and animates them every
frame, and removes them on `leave` or when the connection drops. Whatever
touches `socket` is the transport; the rest is the same on any backend.
[`examples/pubsub-server.mjs`](examples/pubsub-server.mjs) is such a server,
in about 30 lines of Node. Before going public it also needs what the relay
does: refuse origins other than your world's, check every field, and limit
rates and room sizes.

### On other backends

Only the transport changes. Rooms, ids and presence map like this:

| Backend | Send | Receive, with the sender's id | Joins and leaves |
| --- | --- | --- | --- |
| Nakama, relayed match (`socket.joinMatch(matchId)`) | `socket.sendMatchState(matchId, opCode, json)`, one op code per `t` | `socket.onmatchdata`: `op_code`, `data`, `presence.session_id` | `socket.onmatchpresence`: `joins`, `leaves` |
| Colyseus (`client.joinOrCreate('world')`) | `room.send(t, data)` | `room.onMessage('*', (t, data) => …)`; the room relays with `this.onMessage('*', (client, t, data) => this.broadcast(t, { ...data, from: client.sessionId }, { except: client }))` | the room broadcasts `join` and `leave` from `onJoin` and `onLeave` |
| PartyKit | `PartySocket` works like `WebSocket`, so the example as it is | the party relays each message to the others with `from` set to the sender's connection id | the party's `onConnect` and `onClose` |
| Supabase Realtime (`supabase.channel(room, { config: { presence: { key: id } } })`) | `channel.send({ type: 'broadcast', event: t, payload })` | `channel.on('broadcast', { event: t }, ({ payload }) => …)`; put `id` in the payload as `from` | `channel.on('presence', { event: 'join' }, ({ key }) => …)`, and `'leave'`, after `channel.track({})` |
| Ably (`new Realtime({ …, echoMessages: false })`, `channels.get(room)`) | `channel.publish(t, data)` | `channel.subscribe((message) => …)`: `name`, `data`, `connectionId` | `channel.presence.subscribe('enter', …)`, and `'leave'`, after `channel.presence.enter()` |

### What you give up

The relay client does more than the example, and some of it only works with
the relay:

- **“World is full.”** The hub's doors read how full a world is from the
  WorldMesh relay, so they cannot say “World is full” for a world on its own
  backend. Inside the world, the full-screen overlay, its **Try again** and the
  `room:full` event come from the relay client too: if your backend turns
  someone away, show your own message (`world.releasePointer()` frees the
  cursor first).
- **The daily allowance** and its single-player fallback belong to the shared
  relay, and do not apply.
- **`players` events** come from the relay client. Count your own peers
  instead.
- **Late joiners.** The relay remembers where everyone stands and what they
  wear, and tells newcomers. A server that only forwards, like
  `pubsub-server.mjs`, does not: hence the answer to `join`.
- **The finish.** Figures fading in, other people's footsteps, chat bubbles,
  shared state (a lift, a door), one avatar download at a time, checking a link
  again when the hub's key could not be fetched, reconnecting with backoff. Add
  what you need.
- **Privacy.** WorldMesh's [privacy policy](https://worldmesh.net/privacy)
  covers its relay. What your backend sees and keeps is yours to explain.

## The handle

`loadWorldMesh` resolves to, and `createWorldMesh` returns:

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
world.getSharedAvatar()     // the hub-signed link others may load this visitor's avatar from, or null
world.refreshColliders()    // after adding geometry
world.enterVR()             // requestSession('immersive-vr'); the Enter VR button calls this
world.exitVR()
world.isVR()
world.on(event, fn)         // returns an unsubscribe function
world.dispose()
```

Events: `update`, `portal:enter`, `portal:exit`, `portal:activate`,
`view:change`, `pointer:lock`, `interact`, `respawn`, `avatar:load`,
`avatar:error`, `players`, `room:full`, `vr:enter`, `vr:exit`.

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
import. No server, not even for multiplayer. Your world stays entirely on your hosting, and removing the
`loadWorldMesh` call leaves you with the Three.js project you started with.

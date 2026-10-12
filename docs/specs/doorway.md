# Doorway: walking from one 3D website into another

**Status:** Draft 0.1, October 2026. Working title. Not yet submitted anywhere.
**Editors:** Elias Willnat (WorldMesh).
**License:** [W3C Software and Document License](https://www.w3.org/copyright/software-license/),
the same as the [OMI glTF extensions](https://github.com/omigroup/gltf-extensions),
so any part of it can move there unchanged.
**Intended home:** the scene format as an OMI glTF extension, the message
protocol as a report of the W3C Metaverse Interoperability Community Group.

## Abstract

A *doorway* is a door in one 3D website (the *host*) that shows another 3D
website (the *destination*) live behind it, and lets a visitor walk straight
through into it: same position, same speed, same camera, same character, no
loading screen, no reload. Neither site has to run the other's engine, use
the other's accounts, or trust a platform in between.

Doorway defines three small things:

1. **A doorway scene:** a glTF file of the destination's arrival area, so the
   host can draw it live in the doorway.
2. **A handoff:** a handful of `postMessage` messages with which a host,
   having loaded the destination hidden behind the door, hands the visitor
   over at the doorway.
3. **A discovery file:** how a host finds out a destination supports either.

Everything else (rendering engine, physics, networking, accounts, art
direction) stays the destination's own business.

## Goals and non-goals

Goals:

- Any web 3D engine can implement either side in an afternoon: three.js,
  Babylon.js, PlayCanvas, A-Frame, Godot and Unity web exports, plain WebGL.
- Built on existing open standards: glTF 2.0, `KHR_lights_punctual`,
  `OMI_spawn_point`, VRM, `postMessage`.
- Degrades gracefully: a destination that supports none of it is still an
  ordinary link, and each level below works without the next.
- No central service. A host can be anyone's site; so can a destination.

Non-goals:

- Shared identity or accounts. (Characters travel as files, see §6. Who
  someone *is* belongs to protocols like AT Protocol or OpenID Connect.)
- Multiplayer between sites, or keeping two worlds in sync.
- Anything beyond the moment of crossing: once the destination has the
  visitor, it is an ordinary page of its own.

## Conformance levels

| Level | Destination provides | Visitor experience |
| --- | --- | --- |
| 0 · Link | A URL | The host shows a cover image; walking in loads the page |
| 1 · Window | A doorway scene (§3), or a live view (§3.1) | The doorway shows the destination in 3D, from wherever the visitor stands; walking in loads the page |
| 2 · Walk-through | Level 1 + the handoff (§4) | Walking in continues straight into the real destination, no load |
| 3 · Character | Level 2 + character handoff (§6) | The visitor arrives as their own character |

A host MAY implement any subset and MUST fall back to the level below
whenever the one above fails (§7).

## 1. Terms and conventions

- **Host:** the page the visitor is in, containing the door.
- **Destination:** the 3D website behind the door.
- **Arrival point:** where a visitor stands on arriving at the destination
  without a door (its ordinary spawn).
- **Destination space:** the destination's own world coordinates.

All coordinates are glTF's: right-handed, **+Y up**, metres. A heading
(`yaw`) is radians about +Y; **yaw 0 faces −Z**, and positive yaw turns
toward −X (counter-clockwise seen from above), as for glTF cameras. Pitch is
radians, positive looking up.

The key words MUST, SHOULD and MAY are to be read as in RFC 2119.

## 2. Discovery

A destination announces what it supports in a JSON file at

```
/.well-known/doorway.json
```

served with `Access-Control-Allow-Origin: *`:

```json
{
  "doorway": 1,
  "scene": "/doorway/scene.glb",
  "embed": true,
  "characters": ["vrm", "glb"]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `doorway` | integer | Spec version. `1` for this draft. Required. |
| `scene` | URL | The doorway scene (§3), relative to the file. Level 1. |
| `view` | boolean | The destination draws a live view of itself (§3.1). Level 1. |
| `embed` | boolean | The destination implements the handoff (§4). Level 2. |
| `characters` | string[] | Character formats it accepts (§6). Level 3. |

Hosts MUST ignore fields they don't know. A host MAY also learn the same
facts some other way, e.g. a capture service that renders the destination
itself (this is how WorldMesh's hub works today, §9).

## 3. The doorway scene

A glTF 2.0 binary (`.glb`) of the destination's arrival area, in destination
space, so a host can draw it behind a doorway from the visitor's own
viewpoint every frame.

Contents:

- **Meshes** within a radius of the arrival point (RECOMMENDED: 60 m), as
  they look, with their materials and textures. RECOMMENDED: under 2 MB and
  100,000 triangles, textures at most 1024 px. Static only; no animation is
  required to be played.
- **Exactly one node with `OMI_spawn_point`:** the arrival point. Its
  translation is where the visitor's feet are; its rotation is the arrival
  heading (the visitor faces the node's −Z). The node's `extras.eyeHeight`
  (metres above the feet) gives the eye height the backdrop was taken from;
  default 1.6.
- **Lights** as `KHR_lights_punctual`. A light's `extras.castShadow` (boolean)
  and `extras.shadow` (`{ mapSize, bias, normalBias }`) MAY say how it casts
  shadows; a mesh node's `extras.castShadow` / `extras.receiveShadow` whether
  it does.
- **Ambient and sky light**, which `KHR_lights_punctual` has no type for,
  MAY be given as `scene.extras.ambient`: a list of
  `{ "type": "ambient", "color": [r, g, b], "intensity": i }` or
  `{ "type": "hemisphere", "color": [r, g, b], "groundColor": [r, g, b], "intensity": i, "direction": [x, y, z] }`
  (the direction the sky light comes from, in destination space).
- **Fog** MAY be given on the scene, as `scene.extras.fog`: either
  `{ "color": [r, g, b], "near": n, "far": f }` or
  `{ "color": [r, g, b], "density": d }`, colours linear 0–1.
- **Backdrop** (RECOMMENDED): everything beyond the radius (sky, far
  scenery) as a cube map photographed from the eyes at the arrival point,
  referenced from `scene.extras.backdrop`:

  ```json
  { "uri": "backdrop.webp", "faceSize": 1024 }
  ```

  The image is a 3×2 atlas, faces in the order +X, −X, +Y, −Y, +Z, −Z, left
  to right then top to bottom, **relative to the arrival heading** (so −Z is
  straight ahead on arrival). Side faces have +Y up; the +Y face has +Z up,
  the −Y face −Z up.

> **Proposed OMI extension.** The backdrop, fog, ambient light and eye height
> are the only things above without an existing standard. They are written as `extras`
> here so the file is valid today; the intent is to propose them to OMI as one
> small scene-level extension (working name `OMI_doorway_scene`).

### Placing it behind a door

The host stands the scene so the arrival point is a short distance (RECOMMENDED
0.6 m) behind the doorway plane, facing out through the door, its ground level
with the host's floor. It then draws the scene from its own camera, clipped to
the doorway, over the backdrop. The transform it used is the **placement**
`P` (destination space → host space); the handoff uses its inverse.

### 3.1 Live view

A destination whose look can't be carried in a glTF file (custom shaders,
live simulation, other people) MAY draw the doorway itself instead. The
host loads it in an iframe with the query parameter `doorway-view`, under its
own canvas, and leaves the doorway's pixels transparent so the frame shows
through them; anything in front of the door still covers it.

The destination then posts `{ "type": "doorway:view-ready" }` to its parent.
Every frame the host posts:

```json
{
  "type": "doorway:view",
  "camera": { "position": [0.4, 2.6, 5.1], "quaternion": [0, 0, 0, 1], "fov": 70 },
  "viewport": { "width": 1280, "height": 800 },
  "rect": [512, 180, 768, 470]
}
```

| Field | Meaning |
| --- | --- |
| `camera.position`, `camera.quaternion` | The host camera in the **door frame**: metres, the doorway's threshold at the origin, +Y up, −Z through the doorway. |
| `camera.fov` | Vertical field of view, degrees. The aspect is the viewport's. |
| `viewport` | The frame's size in CSS pixels; it covers the host's canvas exactly. |
| `rect` | Where the doorway is, `[left, top, right, bottom]` CSS pixels: the only part seen. |

The destination maps the door frame onto a place of its choosing (its own
arrival view, at its own scale), draws from that camera, and posts
`{ "type": "doorway:view-frame" }` after the first frame, before which the
host keeps its cover. It SHOULD draw only `rect`, only when a view arrives,
and nothing on the host's side of the doorway plane. A live view shows no UI,
takes no input and joins no session.

It costs the host a second running page, so a host SHOULD run at most one,
for the nearest door, only while it is close and on screen, and MAY keep the
cover on devices that can't afford it. The destination's server MUST allow
the `doorway-view` page to be framed by the hosts it accepts
(`Content-Security-Policy: frame-ancestors`), and SHOULD allow no other page.

## 4. The handoff

### 4.1 Waiting behind the door

When the visitor comes near a Level 2 door (RECOMMENDED 24 m), the host loads
the destination in a hidden `<iframe>` with the query parameter

```
?doorway-embed=1
```

An embedded destination MUST:

- stay **dormant**: not join multiplayer, not play sound, not count a visit,
  and render rarely (RECOMMENDED at most 4 frames per second), until entered;
- load everything it needs to show its arrival area at once;
- post `{ "type": "doorway:ready" }` to its parent once it can be entered.

The destination MUST allow being framed by hosts it is willing to receive
visitors from (`Content-Security-Policy: frame-ancestors …`). A destination
that does not want to be framed simply isn't Level 2.

### 4.2 Crossing

The host lets the visitor walk into the doorway (the door is no longer a
wall) and, as the camera reaches the doorway plane, freezes its own frame and
posts:

```json
{
  "type": "doorway:enter",
  "url": "https://destination.example/?from=https%3A%2F%2Fhost.example%2F",
  "pose": {
    "position": [0.1, 0.0, -0.4],
    "velocity": [0.0, 0.0, -4.2],
    "camera": [0.1, 1.9, 1.6],
    "yaw": 0.05,
    "pitch": -0.12,
    "facing": 0.0,
    "mode": "third",
    "fov": 70,
    "color": "#8cd3ff"
  }
}
```

All positions and directions are in **destination space**: the host maps its
own values through `P⁻¹`.

| Field | Meaning |
| --- | --- |
| `url` | The address the destination should show (same origin as the destination, or ignored). Carries `from` for the way back (§5). |
| `pose.position` | The visitor's feet. Required. |
| `pose.velocity` | Metres per second, so a running visitor keeps running. |
| `pose.camera` | The camera's position, so a third-person camera keeps its distance. |
| `pose.yaw`, `pose.pitch` | Where the camera looks. |
| `pose.facing` | Where the body faces (may differ from `yaw` in third person). |
| `pose.mode` | `"first"` or `"third"` person. |
| `pose.fov` | Vertical field of view, degrees. The destination MAY ease back to its own. |
| `pose.color` | Optional tint for a default body. |

The destination MUST then:

1. replace its address with `url` if it is same-origin (`history.replaceState`);
2. put the visitor and camera exactly at `pose` (ignoring any malformed field);
3. leave dormancy: join multiplayer, start sound, resume full-rate rendering;
4. post `{ "type": "doorway:entered" }` once a frame from that pose has been
   drawn (RECOMMENDED: after two animation frames).

On `doorway:entered` the host shows the iframe in its own place (full
viewport, focused) and stops rendering. From here the destination owns the
visitor. The two frames match, so the crossing can't be seen.

### 4.3 While inside

The page around the destination is still the host's, so:

- The destination asks the host to go anywhere else with
  `{ "type": "doorway:navigate", "url": "https://…" }` instead of setting
  `location` itself. Hosts MUST only follow `http:` and `https:` URLs.
- Input still held from the host (a touch joystick mid-swipe) MAY be carried
  over with `{ "type": "doorway:carry", "x": 0, "z": -1 }`; the destination
  keeps moving that way until a message with `x` and `z` both 0.

## 5. The way back

`from` in the destination's address is the host page to return to. A
destination's exit (its own portal or menu item back) SHOULD lead there. The
host SHOULD push a history entry when the destination takes over, so the
browser's Back button returns the visitor to the door they came through.

## 6. Characters (Level 3)

While the destination is still dormant, the host MAY hand over the visitor's
character so it is on screen from the first frame:

```json
{ "type": "doorway:character", "format": "vrm", "name": "Mika", "data": "<ArrayBuffer>" }
```

`data` is the model file itself (an `ArrayBuffer`, copied or transferred),
so nothing is downloaded twice and the destination needs no account
anywhere. An implementation MAY add its own fields under a key named after
itself (WorldMesh adds `worldmesh: { descriptor, ticket }`); others ignore
them. `format` is
one of the destination's `characters` (§2): `"vrm"` (VRM 0.x or 1.0) or
`"glb"` (rigged glTF). `null` instead of a model means "use your default
body". The destination answers `{ "type": "doorway:character-ready",
"loaded": true | false }`.

A destination MUST validate the file (format, size, RECOMMENDED limit 30 MB)
and MAY accept characters only from host origins it trusts.

## 7. Failure and fallback

Every step has a time limit, and every failure falls back to an ordinary
page load (`location.href = url`), never to a stuck visitor:

| If | Within | Then |
| --- | --- | --- |
| No `doorway:ready` | 12 s of loading | Drop the iframe; the door becomes Level 1 or 0 for this visit |
| No `doorway:entered` | 3 s of `doorway:enter` | Load the destination normally |
| The doorway scene fails to load | | The door shows the cover image (Level 0) |

## 8. Security and privacy

- **Origins.** Every message handler MUST check `event.source` (the parent,
  or that iframe). Hosts SHOULD post with the destination's exact origin as
  `targetOrigin`. Destinations MAY restrict which host origins they enter for.
- **Nothing secret travels.** Pose and character data are things the
  visitor already shows everyone. Session tokens, account data and keys MUST
  NOT be put in any Doorway message or in the `url`.
- **Dormant means silent.** An embedded destination not yet entered MUST NOT
  track, count, connect to multiplayer or play sound: the visitor has not
  chosen to go there yet.
- **Navigation.** Hosts follow `doorway:navigate` only for `http(s)` URLs and
  only after `doorway:entered`.
- **Resources.** Hosts SHOULD keep at most one destination waiting at a time,
  and drop it when the visitor walks away (RECOMMENDED past 32 m).
- **Files from strangers.** The doorway scene and characters are untrusted
  input; parse them with ordinary glTF loaders and size limits.

## 9. Relation to existing work

- **glTF 2.0** (Khronos) carries the scene; **`KHR_lights_punctual`** its
  lights; **VRM** (VRM Consortium) characters.
- **`OMI_spawn_point`** (OMI, stage 1) marks the arrival point.
- **`OMI_link`** (OMI, archived) described a link on a node. Doorway covers
  what happens when that link is *walked through*; a scene MAY still mark its
  own outgoing doors with `OMI_link`.
- **WorldMesh** implements Doorway in its hub and `@worldmesh/runtime` (MIT):
  - doorway scenes are written and read as §3 describes (`OMI_spawn_point`,
    `KHR_lights_punctual`, `extras`);
  - the handoff uses the `doorway:*` messages and `doorway-embed`; the
    pre-standard `worldmesh:*` names and `worldmesh-embed` are still accepted;
  - the hub reads a destination's own `/.well-known/doorway.json` first, and
    falls back to WorldMesh's capture service; preview deploys publish each
    demo world's Doorway scene on the world itself;
  - live views (§3.1) for destinations whose Doorway file has `"view": true`,
    the nearest door within 15 m only (`apps/hub/src/walk/liveDoors.ts`);
  - characters travel as `doorway:character` (§6), with the Avatar Wallet's
    descriptor and ticket under `worldmesh`; the pre-standard
    `worldmesh:avatar` is still understood;
  - doorway scenes pass the Khronos glTF Validator with no errors or
    warnings (it reports `OMI_spawn_point` as an extension it doesn't know).

## 10. Open questions

1. **Name.** "Doorway" is a working title; OMI may prefer `OMI_` naming for
   the scene part.
2. **Moving things.** Should the scene be allowed animations (a turning
   windmill), and must hosts play them?
3. **Two-way doors.** Should a destination be able to show its *own* doorway
   back to the host on arrival, using the host's doorway scene?
4. **XR.** In an immersive WebXR session the host can't show an iframe;
   crossing there needs the browser's help (WebXR navigation), so Level 2 is
   2D-screen only for now.
5. **Consent for characters.** Should the visitor confirm before their
   character file is handed to a destination for the first time?

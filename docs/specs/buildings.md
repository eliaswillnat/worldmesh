# Buildings: a world's own front in the hub city

**Status:** Draft 0.4, October 2026. Steps 1 to 3 (§9) are built: demo
buildings stand on the city's first lots with `?buildings=demo`, accounts
have My buildings, and a building linked to a world and approved stands in
place of that world's block.
**Owner:** Elias Willnat.
**Builds on:** [avatar-wallet.md](../avatar-wallet.md) (where models live and
how they load), [doorway.md](doorway.md) (what a door can show and how
visitors walk through it).

## Summary

Every world in the hub city has a block of its own: the same plain white
default building, its door and fascia sign in the middle of the wall facing
the rotunda. A **building** replaces that whole block with a 3D model the
world's creator made: a temple, a shop, a spaceship hangar, a sign saying
"come in".
One face of the model, given a material named `portal`, becomes the world's
door, with everything a hub door does today: the cover, the ripple as you
approach, the live view, walking through.

The rule that holds for characters holds for buildings: **WorldMesh stores
the pointer, never the model.** Buildings live in the creator's own Sketchfab
or AT Protocol account and download in each visitor's browser, straight from
there.

```
creator                      hub (worldmesh.net)                          visitor's browser
 Blender / AI tool
   └─ GLB with a `portal` ──► My buildings (pointer in D1) ─┐
      material, uploaded      link to a world ◄── world's   │
      to Sketchfab or PDS     worldmesh.json names it       │
                              review: approve + pin hash ───┤
                                                            ▼
                              /api/account/building/worlds  ──► which worlds, which hash
                              /api/account/building/resolve ──► modelUrl ──► GET from Sketchfab S3 / PDS
                                                                             fit to lot, portal face → Door
```

## Goals and non-goals

Goals:

- A creator can make a building in an afternoon with tools they already
  have (Blender, an AI 3D generator, Sketchfab), with **one rule** to learn:
  name the door's material `portal`.
- Walking the city stays smooth however many worlds have buildings.
- No model, texture or file ever passes through WorldMesh.
- Nothing appears in the shared hub without a person approving it.

Not in this version:

- **More than one portal per building** (a building whose inside holds
  several worlds). The format leaves room for it (§3.4); the hub uses the
  first portal only.
- **Walking around inside a building.** The model is a façade you can look
  at; the inside is the world behind the portal.
- **Buildings in the hall.** The doors inside the rotunda keep their
  standard frames. A world with a building shows it once its door is out in
  the city.
- Animation, sound, scripts or lights in the model. Static meshes and
  materials only.

## 1. Terms

- **Building:** a glTF 2.0 binary (`.glb`) a creator made to stand in for
  their world's default block.
- **Lot:** the box of city a building may fill (§2).
- **Portal face:** the triangles of the building that use a material named
  `portal` (§3.2). They become the world's door.
- **Link:** the pairing of one building with one world, approved by
  WorldMesh (§5).

Coordinates are glTF's: +Y up, metres. The **front** of a glTF model faces
+Z, as the glTF specification recommends.

## 2. The lot

**One world, one block.** The city's blocks are 28 m squares, and each
world has one to itself, its door in the middle of the wall facing the
rotunda (`apps/hub/src/walk/avenuePlan.ts`). The plain white block is the
world's **default building**. A building of its own **replaces the whole
block**: the block is not drawn at all while the building stands there.

| | Size | Why |
| --- | --- | --- |
| Width, along the door's wall | 28 m | The whole block, centred on the door |
| Depth, back from the wall | 28 m | The whole block |
| Forecourt, out into the street | 2 m | Steps, a sign or a statue; the street is 16 m wide, so 12 m stays clear |
| Height | 28 m | Twice the blocks' 14 m roof line, so a building can rise above the street, still well under the rotunda's dome |

A block that a building can replace is built on its own, not into the
city's shared meshes (`buildAvenues`, `lots`), so it can step aside. Until
the building is ready, and whenever it can't be shown, the default block
stands there as always, so the street never misses a door. The world's
**name and gate number stay**, over the portal face instead of on the
block's fascia, so every door in the city still reads the same way.

The forecourt and height live in `facade.ts` (`LOT_FORECOURT`,
`LOT_HEIGHT`); the width and depth are the block's.

## 3. Making a building

### 3.1 The file

- **glTF 2.0 binary (`.glb`)**, one file, textures embedded.
- **Up to 10 MB, 150,000 triangles, textures up to 2048 px.** A building
  over these limits is refused when it is linked (§5), not discovered by
  visitors later.
- Static meshes with standard (PBR) materials. `KHR_texture_transform`,
  `KHR_materials_emissive_strength` and `KHR_mesh_quantization` are fine.
  Draco and meshopt compression are **not** accepted in this version (they
  would mean hosting decoders; see §10).
- **Front faces +Z.** Any scale: the hub fits it to the lot (§6.2).

### 3.2 The portal face

Give the face (or faces) you want people to walk through **a material named
`portal`**. That is the whole rule.

- Matched case-insensitively, ignoring a Blender-style suffix:
  `portal`, `Portal`, `portal.001` all count.
- The face should be **flat, roughly a rectangle, and roughly upright**
  (facing within 30° of horizontal). Two triangles is ideal; a subdivided
  plane or an arch-topped shape also works.
- **At least 2 m × 2.5 m** once the building is fitted to its lot, so a
  visitor fits through.
- **Nothing of the building in front of it.** The door is drawn just in
  front of the face; anything of the model that pokes out further shows
  through the door. (The first demo observatory had its drum bulging past
  the porch, and it showed as a grey wedge in the doorway.)
- What the material looks like doesn't matter: the hub replaces it.

In Blender: select the face in Edit Mode, add a material slot, create a
material named `portal`, press *Assign*, then *File → Export → glTF 2.0
(.glb)*. Blender writes each material's triangles as their own glTF
primitive, so no separate object is needed.

AI 3D generators (Meshy, Tripo and the like) produce GLBs too. Open the
result in Blender to assign the `portal` material, then upload it (§4.1).
Their own download links expire after a few days, so they cannot be used
directly.

### 3.3 No portal face?

A building without a `portal` material still works: the hub sets a standard
door into its front (+Z side), centred, on the ground. If the face is there
but unusable (not flat, lying down, too small) the building is refused at
link time with the reason, so the creator can fix it.

### 3.4 Room for later: several portals

A later version may let one building hold several worlds. Reserved now so
files made today keep working: a material named `portal:<name>` (e.g.
`portal:arena`) is a named portal. This version treats a building's first
portal, in file order, as its door and ignores the rest.

## 4. Where buildings live

### 4.1 Providers

Buildings use the Avatar Wallet's provider connections
(`avatar_connection`). A user who already connected Sketchfab or AT Protocol
for characters doesn't connect again.

| | Sketchfab | AT Protocol |
| --- | --- | --- |
| Where the file lives | The user's Sketchfab account | A `net.worldmesh.building` record and its blob in the user's own PDS |
| Uploading from the hub | As for characters: browser posts the GLB to `/v3/models` as a draft (`sketchfabUpload.ts`) | As for characters, with a grant for `repo:net.worldmesh.building?action=create blob:model/gltf-binary` (`at3dUpload.ts`) |
| Listing | `GET /v3/me/models` | `com.atproto.repo.listRecords` for `net.worldmesh.building` |
| Loading | `GET /v3/models/{uid}/download` → presigned GLB URL, valid about 5 minutes | `com.atproto.sync.getBlob`, public |
| Version marker | Checked by hash (§5.3) | The blob's CID, plus the hash |

The AT Protocol record type is **our own** (`net.worldmesh.building`, under
the worldmesh.net domain), not an `app.at3d.*` one: at3d's namespace belongs
to at3d, and `app.at3d.avatar` means a character. Its lexicon is
[docs/lexicons/net.worldmesh.building.json](../lexicons/net.worldmesh.building.json).
The hub writes the name, the model and when; a thumbnail and a source link are
optional:

```json
{
  "$type": "net.worldmesh.building",
  "name": "The Forest Gate",
  "model": { "$type": "blob", "ref": { "$link": "bafkrei…" }, "mimeType": "model/gltf-binary", "size": 4182016 },
  "createdAt": "2026-10-19T12:00:00.000Z"
}
```

Only records whose model is a `model/gltf-binary` blob are offered. The
AT Protocol client's metadata asks for both upload scopes, characters' and
buildings', and each upload asks for only the one it needs.

Only the user's **own** models can be picked, as with characters: the
licence question is theirs to answer.

**Size:** the 40 MB cap on characters is ours (`DEFAULT_MAX_BYTES` in
`packages/runtime/src/avatar/loader.ts`), not AT Protocol's. Buildings have
their own, smaller one (10 MB, §3.1). Each PDS sets its own largest blob; a
building too big for the user's PDS goes to Sketchfab instead.

### 4.2 My buildings

Next to **My characters**, the account dialog has **My buildings**
(`apps/hub/src/myBuildings.ts`): up to 20 saved buildings, each a pointer,
in the `building` table (`db/migrations/0008_buildings.sql`). Each gets an
id, `bld_` and 16 random characters, which only its owner sees; it is what a
world's manifest will name (§5).

Endpoints, under `/api/account/building` in `workers/auth`
(`src/avatars/buildings.ts`), same-origin and signed in:

| | |
| --- | --- |
| `GET /list` | The platforms that hold buildings, their connections, and the saved buildings |
| `GET /connections/:id/models` | The account's models, live from the platform, with each GLB's size |
| `POST /collect` `{ connectionId, modelId }` | Saves one, checked with the platform: only the account's own models |
| `POST /rename` `{ buildingId, name }` | Names it here; `null` goes back to the platform's name |
| `POST /remove` `{ buildingId }` | Its links go with it |
| `POST /link` `{ buildingId, world }` | Puts it on a world whose manifest names it, for review (§5.1) |
| `POST /unlink` `{ buildingId, world }` | |

`GET /list` gives each saved building its `worlds`: `{ url, status, reason }`.

Connecting a platform, and the permission to upload, go through the Avatar
Wallet's endpoints: `POST /api/account/avatar/connect/:provider` with
`{ upload: 'building' }` asks for a grant that can only upload a building, and
the platform sends the browser back to `/?avatar=upload&provider=…&kind=building`.
VRoid Hub holds characters only. Disconnecting a platform, or connecting it
again as another account, removes its saved buildings.

**Before uploading, the file is checked in the browser** the way the city
checks it before showing it (`walk/buildingModel.ts`, `inspectBuilding`): the
size, compression, triangles and textures, then the portal face, fitted to a
block. Its maker sees straight away why a file won't stand, or the door it
will have ("Its portal face makes a 5.7 × 10.1 m door on a block").

## 5. Linking a building to a world

### 5.1 Both sides agree

A building shows on a world's lot only when **both** say so:

1. **The building's owner** picks it in My buildings, chooses *Use* and
   pastes the world's URL.
2. **The world's site** names it, in its own manifest (`worldmesh.json`,
   [compatibility.md](../compatibility.md#the-manifest)):

   ```json
   {
     "worldmesh": 1,
     "name": "Forest",
     "building": "bld_7Hq2kX9mPz"
   }
   ```

The hub shows the line to paste. `POST /link { buildingId, world }` reads
the manifest server-side (both `/.well-known/worldmesh.json` and
`/worldmesh.json`, as the hub already does, through the same guarded fetch
as the Avatar Wallet's: public https only, small and time-limited) and, if it
names the building, records a pending link. This proves control of the world
without WorldMesh having to know who owns which world, and it works for
worlds hosted anywhere. The manifest belongs to the world's origin, so worlds
sharing an origin (`?galaxy=…`) share the proof. A user's buildings stand on
at most 20 worlds together.

Removing the line from the manifest, or *Take off* in My buildings, takes the
building down. The manifest is re-checked daily, without a cron: each look
at the approved list (`GET /worlds`, §7.2) re-reads up to three manifests
last read over a day ago, after answering. A manifest that names another
building, or none, takes the building down; one that can't be read (the site
is down) leaves it standing. Linking a building to a world that already has
one replaces it, back in review: the manifest decides.

```sql
create table building_link (           -- db/migrations/0009_building_links.sql
  world_url text primary key,          -- canonical URL, as the hub compares them
  building_id text not null references building (id) on delete cascade,
  status text not null check (status in ('pending', 'approved', 'rejected', 'hidden')),
  sha256 text,                         -- the approved file's hash (§5.3)
  version text,                        -- the platform's marker for that file (§5.3)
  portal_json text,                    -- the portal face and fit the reviewer saw (§6)
  reason text,                         -- shown to the owner when rejected or hidden
  checked_at integer not null,         -- last manifest check
  reviewed_at integer,
  reviewed_by text,
  created_at integer not null,
  updated_at integer not null
);
```

One world has at most one building. One building may be linked to several
worlds (a studio using the same front for all its worlds); each link is
reviewed on its own.

### 5.2 Review

Worlds are already reviewed before they're listed; buildings are too, since
they stand in a space everyone shares. The admin dashboard (`workers/admin`,
*Buildings*) lists the links, waiting ones first. Reviewing happens on the
hub, at `/review-building` (`apps/hub/src/review/buildingReview.ts`), since it
needs a script and the dashboard's pages run none: the reviewer's browser
downloads the model straight from its platform, checks it as the city does
(§7.3), shows it standing on its block with the portal face in magenta, a
1.8 m figure by the door and the block's room outlined, and lists its size,
triangles, scale and door. *Approve*, *Reject* and *Hide*, the last two with
a reason the owner sees in My buildings.

`workers/auth` answers the page's endpoints for verified emails in its
`ADMIN_EMAILS` var only (the same accounts as the dashboard's):

| | |
| --- | --- |
| `GET /review/queue` | Every link, waiting ones first |
| `GET /review?world=` | The link, its building and owner, and where its file is now |
| `POST /review` `{ world, buildingId, action, sha256, version, portal, reason }` | `approve`, `reject` or `hide`; refused if the world links another building by then |

Until a link is approved, the world keeps its default block. A hidden link
stays hidden: linking the same building again is refused.

### 5.3 Pinning the approved version

A provider lets its user replace a file after it was approved. So approval
pins the **exact file**: the reviewer's browser, which downloaded the model
to show it, computes its SHA-256 and the approval stores that hash. The
server never sees the file, only the hash.

Every visitor's browser hashes the file it downloads (SubtleCrypto, a few
milliseconds for 10 MB) and **shows it only if the hash matches**, else the
default block stays. The approval also stores what the platform said the
file was (`version`): the blob's CID on AT Protocol, the GLB's size on
Sketchfab. When resolving finds a different one, the building is taken back
into review before anything is downloaded, and its owner sees why.

## 6. Fitting a building in

Done once at review (and shown there), and again in each visitor's browser
on load, so the hub never trusts stored geometry.

### 6.1 Finding the portal face

1. Collect every primitive whose material name matches §3.2.
2. Transform its triangles into the building's space. Drop the primitive
   from what's drawn.
3. **Normal:** the area-weighted average of the triangles' normals. Every
   triangle must lie within 2% of the face's size of the plane through
   their centroid with that normal; otherwise the face isn't flat.
4. **Upright:** the normal within 30° of horizontal. If it points into the
   building (towards the model's centre), flip it.
5. **Rectangle:** project the triangles onto the plane and take the smallest
   upright rectangle round them. Its width, height and centre are the door's.

The result is `{ center, normal, width, height }` in the model's own units,
stored in `building_link.portal_json` for the admin view.

### 6.2 Fitting the building to its lot

- **Turn** the model so the portal face's normal points out into the street.
  Without a portal face, its +Z points out.
- **Scale** uniformly, never stretched, to the largest size at which the
  part in front of the portal fits the forecourt, the part behind it fits
  the block's depth, and the whole fits the block's width and the lot's
  height.
- **Stand** the portal face's bottom edge on the street, so visitors walk
  straight in. Anything lower goes under the street. Without a portal face,
  the model's lowest point stands on the street.
- **Place** it so the portal face sits on the line where the block's
  door stood (0.3 m in front of the wall line), centred on the lot's width.

### 6.3 Checking the size

The fitted portal face must be at least 2 m × 2.5 m (§3.2). A smaller one
is refused at review with the reason.

## 7. In the hub

A new module, `apps/hub/src/walk/buildings.ts`, owns everything here. The
lobby asks it for a lot's building and gives it the door to dress.

### 7.1 Streaming

Buildings load only near the visitor, nearest first:

| | Default |
| --- | --- |
| Start loading within | 90 m |
| Unload beyond | 140 m |
| Loaded at once, at most | 8 |
| Downloads at once, at most | 2 |

Until a building is ready the default block stands there, so the street is
never missing a door. When it's ready the block swaps for the
building with a short fade, and only while the visitor isn't standing in
the doorway.

Parsed buildings are kept in memory while loaded. Downloaded files are kept
in the browser's Cache Storage under the building's hash (24 at most, the
oldest dropped first), so a second visit costs no download and no call to
`/resolve`; a cached file is hashed again before it is used. Nothing is
cached by WorldMesh.

### 7.2 Resolving

`GET /api/account/building/worlds` (CORS, cookie-less) lists the worlds
with an approved building and the hash each must have:
`{ worlds: [{ url, sha256 }] }`. The hub reads it once as the city goes up
(`walk/buildingDirectory.ts`) and lays out a lot only for those worlds'
blocks, so it only resolves lots that have a building. (The spec first
put a `building` flag in `GET /api/worlds`; that is a Pages Function on KV,
which can't see the links in D1.)

`POST /api/account/building/resolve { worlds: [url, …] }` (CORS,
cookie-less, rate-limited, up to 16 URLs per call) answers, per approved
link, `{ modelUrl, expiresAt, sha256 }`. The city asks it for the lots
coming into reach that aren't in the browser's cache, nearest first, one
call at a time. For Sketchfab the Worker asks the download API with the
owner's stored tokens; for AT Protocol it reads the record again for its
blob. Either answer is kept for up to five minutes (and never closer than a
minute to the link expiring), so visitors share it rather than each calling
the platform. That's a cached pointer; the model still goes straight from
the platform's storage to the visitor.

### 7.3 Loading checks

Before and after parsing, in the visitor's browser (three.js `GLTFLoader`,
as the runtime already uses for characters):

- `Content-Length` and the streamed byte count at most 10 MB.
- SHA-256 equal to the approved hash.
- At most 150,000 triangles and textures at most 2048 px; no Draco or
  meshopt extension.

Any failure keeps the default block, quietly, for that visit.

### 7.4 The door in the portal face

The portal face becomes a `Door` (`apps/hub/src/walk/door.ts`), sized to the
face's rectangle and without its own frame, sill or halo, since the building
is the frame. Everything else is the door every world already has: the
cover, the ripple when someone approaches, the live view for worlds whose
Doorway file says `"view": true` (`liveDoors.ts`), and the walk-through for
`"embed": true`. Coming back from the world lands the visitor in front of
it, as with any door today.

`Door.setShape({ width, height, span })` gives a door its own size and drops
its frame; `setShape(null)` puts back the standard one. The same door object
stays throughout, so live views, walking through and occupancy carry on
untouched. A shaped door stands 4 cm in front of the portal face, clear of
whatever the face was drawn on.

### 7.5 Collisions

While the default block shows, it is solid as always. Once the building
shows, a box round the building is: as wide and tall as the fitted model,
from the wall line back. Visitors reach its door as they reached the
block's, and go no further. Steps, columns and signs in the forecourt are
not solid in this version.

### 7.6 Light

The lobby is lit for its white walls, about three times as brightly as a
model is usually lit for. A building's colours are taken down to 0.6 so they
look as their maker meant instead of bleached; metal less so, since its
colour tints what it reflects. The lobby has no environment for metal to
reflect, and metal with nothing to reflect renders black, so buildings'
metallic materials get a soft studio environment of their own
(`RoomEnvironment`). Nothing else in the lobby changes.

## 8. Safety

- **Review** before anything shows (§5.2), and the **hash pin** (§5.3)
  means what was approved is what's shown.
- **Report:** a door's info card gets *Report this building*. Reports reach
  the admin dashboard, where *Hide* takes the building down at once
  (`status = 'hidden'`) and tells its owner why.
- **Parsing limits** (§7.3) are enforced in every browser, whatever the
  server said.
- **Privacy:** downloading a building tells Sketchfab or the PDS the
  visitor's IP address, as loading a character already does. Private mode,
  which sends no character, also loads no buildings.

## 9. Building it, in order

1. **Buildings in the hub from a fixed list.** *Built.* `buildings.ts`,
   `buildingFit.ts`, the lots in `avenues.ts`, `Door.setShape`, streaming.
   The demo worlds all stand in the hall, which has no lots, so the five demo
   buildings stand in for the first five city doors instead, and only with
   `?buildings=demo` on the hub's address. Without it nothing in the city
   changes. The demo models come from
   `node apps/hub/scripts/demo-buildings.mjs`, which writes the GLBs to
   `apps/hub/public/buildings/` and their hashes to
   `apps/hub/src/walk/demoBuildings.json`.
2. **My buildings.** *Built.* The `building` table and endpoints, listing
   from Sketchfab and AT Protocol, uploading (reusing both upload paths) with
   the file checked first, the UI next to My characters (§4.2).
3. **Links and review.** *Built.* `building_link`, `/link` with the manifest
   check and its daily re-check, the Buildings page in the admin dashboard
   and the review page on the hub (viewer, checks, hash), `/worlds` and
   `/resolve`, the city resolving and caching approved buildings, and
   *Use* in My buildings.
4. **Reports and hiding.**
5. **Creator docs.** A page on worldmesh.net (next to `creators.html`) with
   the Blender steps, the limits and a downloadable example building.

## 10. Open questions

- **The name on a dark building.** The name over a shaped door is drawn for
  the white lobby; on dark stone it is hard to read. It may want a backing
  plate.
- **Light tuning.** 0.6 for colours and the studio's strength are first
  guesses from software-rendered screenshots; walk the preview to judge.

- **Does Sketchfab keep material names?** Sketchfab converts every upload;
  its downloadable GLB has to be checked to still call the material
  `portal`. If it doesn't, a node named `portal` (Blender: split the face
  into its own object) is the fallback rule.
- **More worlds.** One world to a block holds 20 worlds in the first ring
  round the plaza and 48 in the two rings always drawn; past that the city
  grows a ring at a time, up to 240 worlds in six rings.
- **Compression.** Draco or meshopt would let buildings be much smaller.
  Both need decoder files served from somewhere; worth it once buildings
  hit the 10 MB limit in practice.
- **Publishing the lexicon.** The file is in
  [docs/lexicons](../lexicons/net.worldmesh.building.json), and servers accept
  the records without it. Publishing it for others to resolve takes a
  `_lexicon.worldmesh.net` DNS record naming a DID, and the schema as a
  `com.atproto.lexicon.schema` record in that DID's repository.
- **Linking on the preview.** Preview worlds sit behind Cloudflare Access,
  so the auth Worker reading their manifest gets Access's login page and
  linking refuses them. Trying links on the preview needs a world hosted
  elsewhere (any public https site with a `worldmesh.json`).
- **Notifying reviewers.** A new link only shows on the dashboard's overview.
  An email to the reviewers may be worth it once links come in regularly.
- **Fab.com and other stores.** No public download API is known that would
  let a visitor's browser fetch a creator's own model. Sketchfab and AT
  Protocol cover it for now.

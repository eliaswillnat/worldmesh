# Buildings: a world's own front in the hub city

**Status:** Draft 0.2, October 2026. Step 1 (§9) is built: demo buildings
stand on the city's first lots with `?buildings=demo`.
**Owner:** Elias Willnat.
**Builds on:** [avatar-wallet.md](../avatar-wallet.md) (where models live and
how they load), [doorway.md](doorway.md) (what a door can show and how
visitors walk through it).

## Summary

Every world in the hub city gets a standard storefront today: the same bay,
piers and fascia sign along a block's wall, with the world's door in the
middle. A **building** replaces that storefront with a 3D model the world's
creator made: a temple, a shop, a spaceship hangar, a sign saying "come in".
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
  their world's storefront.
- **Lot:** the box of city a building may fill (§2).
- **Portal face:** the triangles of the building that use a material named
  `portal` (§3.2). They become the world's door.
- **Link:** the pairing of one building with one world, approved by
  WorldMesh (§5).

Coordinates are glTF's: +Y up, metres. The **front** of a glTF model faces
+Z, as the glTF specification recommends.

## 2. The lot

The city's blocks are 28 m squares with one world door in the middle of each
of their four walls (`apps/hub/src/walk/avenuePlan.ts`). So each world
already owns a quarter of a block, and that quarter becomes its lot. The
four lots of a block meet as **wedges in its middle**: a lot runs straight
back at its sides, then narrows to a point behind its door
(`apps/hub/src/walk/avenues.ts`, `lotCut`).

| | Size | Why |
| --- | --- | --- |
| Width, along the wall | 13.5 m | The storefront's opening between its piers (`LOT_WIDTH`), centred on the door |
| Depth, into the block | 13.7 m behind the door, 6.95 m at the sides | Up to the diagonals from the block's corners to its middle, less 0.3 m, so lots never touch |
| Forecourt, out into the street | 2 m | Steps, a sign or a statue; the street is 16 m wide, so 12 m stays clear |
| Height | 28 m | Twice the blocks' 14 m roof line, so a building can rise above the street, still well under the rotunda's dome |

Where a lot holds a building, the lot is cut out of the block, cornice and
roof included, and the beam along the wall stops either side of it. Until the
building is ready, a **plug** fills the cut: wall, cornice, fascia and beam
exactly as the storefront had them, so nothing looks different. Once the
building shows, the plug is hidden. The world's **name and gate number stay**,
over the portal face instead of on a fascia, so every door in the city still
reads the same way.

Only a door alone in the middle of its wall gets a lot. Today that is every
door in the city.

The width, forecourt and height live in `facade.ts` (`LOT_*`); the depth
follows from the block.

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
to at3d, and `app.at3d.avatar` means a character. Its shape:

```json
{
  "$type": "net.worldmesh.building",
  "name": "The Forest Gate",
  "model": { "$type": "blob", "ref": { "$link": "bafkrei…" }, "mimeType": "model/gltf-binary", "size": 4182016 },
  "sourceUrl": "https://sketchfab.com/3d-models/…",
  "createdAt": "2026-10-19T12:00:00.000Z"
}
```

Only the user's **own** models can be picked, as with characters: the
licence question is theirs to answer.

**Size:** the 40 MB cap on characters is ours (`DEFAULT_MAX_BYTES` in
`packages/runtime/src/avatar/loader.ts`), not AT Protocol's. Buildings have
their own, smaller one (10 MB, §3.1). Each PDS sets its own largest blob; a
building too big for the user's PDS goes to Sketchfab instead.

### 4.2 My buildings

Next to **My characters**, the account gets **My buildings**: up to 20 saved
buildings, each a pointer. A new table, shaped like `avatar`:

```sql
create table building (
  id text primary key,                -- 'bld_' + random, shown to the owner only
  user_id text not null references "user" (id) on delete cascade,
  connection_id text not null references avatar_connection (id) on delete cascade,
  provider text not null,             -- 'sketchfab' | 'atproto'
  external_id text not null,          -- Sketchfab uid, or the at:// URI of the record
  display_name text,
  thumbnail_url text,                 -- provider-hosted, for the UI only
  metadata_json text,                 -- size, triangle count, portal face found, …
  created_at integer not null,
  updated_at integer not null,
  unique (connection_id, external_id)
);
```

Endpoints, under `/api/account/building/` in `workers/auth`, mirroring the
avatar ones: `POST /collect`, `POST /rename`, `POST /remove`, `GET /list`.
Disconnecting a provider removes its saved buildings and their links.

## 5. Linking a building to a world

### 5.1 Both sides agree

A building shows on a world's lot only when **both** say so:

1. **The building's owner** picks it in My buildings, chooses *Use for a
   world* and pastes the world's URL.
2. **The world's site** names it, in its own manifest (`worldmesh.json`,
   [compatibility.md](../compatibility.md#the-manifest)):

   ```json
   {
     "worldmesh": 1,
     "name": "Forest",
     "building": "bld_7Hq2kX9mPz"
   }
   ```

The hub shows the line to paste. `POST /link { buildingId, worldUrl }` reads
the manifest server-side (both `/.well-known/worldmesh.json` and
`/worldmesh.json`, as the hub already does) and, if it names the building,
records a pending link. This proves control of the world without WorldMesh
having to know who owns which world, and it works for worlds hosted
anywhere.

Removing the line from the manifest, or *Unlink* in My buildings, takes the
building down. The manifest is re-checked daily.

```sql
create table building_link (
  world_url text primary key,          -- canonical URL, as the directory keys it
  building_id text not null references building (id) on delete cascade,
  status text not null check (status in ('pending', 'approved', 'rejected', 'hidden')),
  sha256 text,                         -- the approved file's hash (§5.3)
  portal_json text,                    -- the portal face found at review (§6), for the admin view
  reason text,                         -- shown to the owner when rejected or hidden
  checked_at integer,                  -- last manifest check
  reviewed_at integer,
  created_at integer not null,
  updated_at integer not null
);
```

One world has at most one building. One building may be linked to several
worlds (a studio using the same front for all its worlds); each link is
reviewed on its own.

### 5.2 Review

Worlds are already reviewed before they're listed; buildings are too, since
they stand in a space everyone shares. Pending links appear in the admin
dashboard (`workers/admin`) with the model in a viewer, fitted to its lot,
the portal face highlighted, and the size and triangle count. *Approve*,
*Reject* (with a reason the owner sees) and, later, *Hide*.

Until a link is approved, the world keeps its standard storefront.

### 5.3 Pinning the approved version

A provider lets its user replace a file after it was approved. So approval
pins the **exact file**: the admin's browser, which downloaded the model to
show it, computes its SHA-256 and the approval stores that hash. The server
never sees the file, only the hash.

Every visitor's browser hashes the file it downloads (SubtleCrypto, a few
milliseconds for 10 MB) and **shows it only if the hash matches**. A
replaced file falls back to the standard storefront and puts the link back
in review. For AT Protocol, a changed blob CID says the same thing before
anything is downloaded.

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
  the lot's depth as the lot narrows (checked on the model's own points, not
  its box, so a round tower gets in further than a square one), and the
  whole fits the lot's width and height.
- **Stand** the portal face's bottom edge on the street, so visitors walk
  straight in. Anything lower goes under the street. Without a portal face,
  the model's lowest point stands on the street.
- **Place** it so the portal face sits on the line where the storefront's
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

Until a building is ready the lot shows the standard storefront, so the
street is never missing a door. When it's ready the storefront swaps for the
building with a short fade, and only while the visitor isn't standing in
the doorway.

Parsed buildings are kept in memory while loaded. Downloaded files are kept
in the browser's Cache Storage under the building's hash, so a second visit
costs no download; nothing is cached by WorldMesh.

### 7.2 Resolving

`POST /api/account/building/resolve { worlds: [url, …] }` (CORS,
cookie-less, rate-limited, up to 16 URLs per call) answers, per approved
link, `{ modelUrl, expiresAt, sha256 }`. For Sketchfab the Worker asks the
download API with the owner's stored tokens and keeps the presigned URL
until a minute before it expires, so visitors share it rather than each
calling Sketchfab. That's a cached pointer; the model still goes straight
from Sketchfab's storage to the visitor.

`GET /api/worlds` gains a `building: true` flag on worlds with an approved
link, so the hub only resolves lots that have one.

### 7.3 Loading checks

Before and after parsing, in the visitor's browser (three.js `GLTFLoader`,
as the runtime already uses for characters):

- `Content-Length` and the streamed byte count at most 10 MB.
- SHA-256 equal to the approved hash.
- At most 150,000 triangles and textures at most 2048 px; no Draco or
  meshopt extension.

Any failure keeps the standard storefront, quietly, for that visit.

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
whatever the face was drawn on. Its backstop spans the whole lot (`span`), so
nobody slips past the door into the building.

### 7.5 Collisions

While the plug shows, it is solid like the storefront was. Once the building
shows, the lot's walls (the cut) and the door's backstop across the whole lot
are solid, so visitors can walk right up to the door but not into the
building. Steps, columns and signs in the forecourt are not solid in this
version.

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
2. **My buildings.** The `building` table and endpoints, listing from
   Sketchfab and AT Protocol, uploading (reusing both upload paths), the UI
   next to My characters.
3. **Links and review.** `building_link`, the manifest check, the admin
   review page with the viewer and the hash, `/resolve`, the `building`
   flag in `/api/worlds`.
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
- **Lot size.** One storefront bay per world keeps the city's grid as it
  is. If buildings should be bigger (a whole block per world), the city
  grows four times as large for the same number of worlds.
- **Compression.** Draco or meshopt would let buildings be much smaller.
  Both need decoder files served from somewhere; worth it once buildings
  hit the 10 MB limit in practice.
- **Lexicon.** `net.worldmesh.building` should be published (a lexicon
  file and DNS for `net.worldmesh`) before AT Protocol uploads ship.
- **Fab.com and other stores.** No public download API is known that would
  let a visitor's browser fetch a creator's own model. Sketchfab and AT
  Protocol cover it for now.

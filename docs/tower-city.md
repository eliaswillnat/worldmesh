# The tower city

Walk mode's city: one cylindrical tower per category standing around the
citadel, floors of doors inside, a slow discovery elevator up the middle,
fast lifts on the walls, and bridges between towers. It replaces the plaza
buildings. The citadel, its doors, presence, private mode and entering worlds
are unchanged.

| Idea | In the city |
| --- | --- |
| scrolling | moving: walking a floor, riding the discovery elevator |
| a post | a door: a 9:16 screen with the world's poster or preview loop, title, creator, badge |
| opening a post | walking into the door (or E, or a tap) |
| a feed | a tower (one per category in `worlds/categories.json`) |
| ranking | height: Trending at the bottom, Rising around bridge levels, Hidden Gems and All-time at the summit |
| switching feeds | a bridge to another tower |

## Listings and doors are different things

A **listing** (`worlds/listing.ts`) is the permanent record of a world: id,
URL, name, cover, preview loops, creator, categories, tags, source (`admin`,
`submitted`, `demo`, `discovered`), claim status (`unclaimed` or `claimed`),
featured flag and status. Every listing source the hub has today (community.json,
`/api/worlds`, the demos) feeds one `WorldRepository`. Listing is free, and
nothing about a listing depends on a WorldMesh account.

A **door** is a slot in a tower (`explore:f12:d3`). Which listing a slot shows
is an **assignment**, computed per rotation window (6 hours by default). A
listing never moves, disappears or gets copied because it rotated off a
door; Trending just references it from a Trending door for a while.

## Modules

Pure modules (no three.js, no DOM) are unit tested in `apps/hub/test` and
could run in a Worker unchanged.

| Module | What it does |
| --- | --- |
| `worlds/categories.ts` + `categories.json` | Categories as data. Adding an entry adds a tower. Keyword inference for listings that name none. |
| `worlds/listing.ts` | The listing model and normalisation from hub records. |
| `worlds/repository.ts` | `WorldRepository` interface and the in-memory implementation; search by name, creator, category and tag. |
| `discovery/rotation.ts` | Rotation windows from a fixed epoch. |
| `discovery/ranking.ts` | Scores from signals: trending (recent momentum), rising, popular, quality, hidden gem, fresh, exposure. Counts are bucketed so small differences between clients do not change a placement. |
| `discovery/placement.ts` | Fills a tower's slots for one window: per-slot strategies, cooldowns, appearance caps, a per-floor limit per creator, new-world boost, honest badges, sponsored-slot hook. |
| `discovery/service.ts` | Caches placements per tower and window, and answers "where is this world now?" for search. |
| `analytics/analytics.ts` | Typed city events and pluggable sinks (none in production yet). |
| `towers/config.ts` | Every tunable in one object (see below). |
| `towers/plan.ts` | The city as numbers: tower positions, floor kinds and bands, where every door, lift and bridge mouth is, and the placement slots. |
| `towers/shell.ts` | Each tower's exterior and interior drum: one draw call each, painted procedurally, taller than the fog. |
| `towers/towerDetail.ts` | The streamed floors near the player: instanced slabs, railings, door frames and lift doors, plus colliders. |
| `towers/doorView.ts`, `cards.ts`, `shutter.ts` | A door's screen shader, the per-world poster and caption cache, and the reassignment shutter state machine (with a sound hook, silent for now). |
| `towers/previews.ts` | Which doors animate and which few play video. |
| `towers/rotationManager.ts` | Runs shutter cycles when a window changes; a door someone is standing at waits. |
| `towers/elevator.ts` | The discovery elevator: motion logic and its view. |
| `towers/bridges.ts` | Bridge geometry, colliders and signs. |
| `towers/hud.ts` | Prompt, location chip, ride controls, fast-lift panel with search, travel screen. |
| `towers/towerCity.ts` | Ties it together per frame; the lobby only talks to this. |
| `towers/debug.ts` | Development overlay (`vite dev` only). |

## A frame

`TowerCity.update` runs after the player moves:

1. Move the elevators and carry whoever stands on a platform.
2. Work out where the player is: which tower and floor, which bridge.
3. Stream: towers within `detailDistance` of the player load the chunk of
   floors around the player's height (`floorsPerChunk`, `chunkRadius`). The
   rest of each tower is only its painted drum.
4. Colliders: the player's floor and the ones above and below, platform
   decks, bridges, tower walls. The runtime's list is refreshed only when
   that set changes.
5. Doors: focus and walk-in entry, rotation, previews, impressions.

## Performance

- Towers: two draw calls each (exterior, interior), whatever their height.
- Floors: slabs, railings, frames and lift doors are `InstancedMesh`es, a
  fixed handful of draw calls per loaded tower. Only floors at the camera's
  height draw their doors and signs.
- Doors: pooled meshes and materials; posters and captions are cached per
  world with reference counting and a size limit (`maxCachedCards`); badges
  and status words come from two shared atlases.
- Video: a fixed pool of `maxActiveVideos` elements (1 on phones, 0 with
  data saver or reduced motion). Far or out of view: a still poster. In view:
  the poster drifts (a shader effect). Closest few in view: the loop plays.
  Out of view for `videoReleaseS`: the element gives its source back.
- The floor mirror only renders from the plaza; inside towers and on bridges
  a plain floor stands in.
- Interiors sit on the camera-only layer, so the mirror never draws them.

## Mobile

Every action is a button as well as a key: the prompt is tappable, taps on a
door enter it, the ride controls are on screen, and the fast-lift panel is a
plain dialog. Nothing depends on hover.

## Configuration

`towers/config.ts` holds them all. The main ones:

| Setting | Default |
| --- | --- |
| `doorsPerFloor` | 5 ground, 8 standard, 5 transfer, 6 summit |
| `floorsPerChunk` / `chunkRadius` | 4 / 1 |
| `bridgeInterval` | every 10 floors |
| `rotationIntervalMs` | 6 hours |
| `videoActivationDistance` / `animationDistance` | 18 m / 30 m |
| `maxActiveVideos` | 3 (1 on phones) |
| `elevatorSpeed` / `elevatorDwellS` | 1.7 m/s / 2.6 s per floor |
| `floorHeight`, `towerRadius` | 7.5 m, 16 m |
| `placement.cooldownWindows` | 2 |
| `bands` | lower 4 floors, middle ±1 floor of bridge levels, summit 3 floors |
| `detailDistance` | 40 m |

In development, `?rotation=60` makes windows a minute long, `?videos=2` and
`?floors=40` override those counts, and the debug overlay can rotate now or
fill the city with 500 test worlds.

## Determinism and multiplayer

Placement is a pure function of the listings, their signals and the window
index; nothing depends on the visitor or a random seed. Everyone who loads the
city in the same window sees the same doors, which is what shared presence
in the towers will need.

The one gap is signals. Today they are the hub's lifetime view counts,
fetched by each browser and bucketed, which keeps visitors in agreement most
of the time but not always. For production:

1. Aggregate city events per listing per day in D1 (see below).
2. At the start of each window, a scheduled Worker computes the ranking
   inputs (or the full placement) once and stores it.
3. Clients fetch that snapshot for the window instead of computing from
   their own view counts. `SignalSource` already has the right shape.

## Proposed D1 changes

Not in this change; to follow once the directory itself moves into D1.

```sql
-- On the directory's world rows:
alter table world add column categories text not null default '[]';  -- JSON ids
alter table world add column tags text not null default '[]';
alter table world add column preview_urls text not null default '[]'; -- muted loops, WebM first
alter table world add column source text not null default 'submitted'
  check (source in ('admin', 'submitted', 'discovered'));
alter table world add column featured integer not null default 0;
-- Claimed means owner_user_id is set; unclaimed listings have none.

create table listing_signal_daily (
  world_id text not null references world (id) on delete cascade,
  day text not null,              -- YYYY-MM-DD, UTC
  impressions integer not null default 0,
  preview_watches integer not null default 0,
  approaches integer not null default 0,
  enters integer not null default 0,
  visits integer not null default 0,
  repeat_visits integer not null default 0,
  saves integer not null default 0,
  primary key (world_id, day)
);

create table placement_snapshot (
  tower_id text not null,
  window integer not null,
  assignments text not null,      -- JSON: slot id → listing id, strategy, badge
  created_at integer not null,
  primary key (tower_id, window)
);
```

Sponsored slots plug into `SponsoredPlacements.pick(tower, slot, window)`;
one slot per transfer deck is already reserved for them and falls back to an
organic pick while there are none.

## Billboards

The old plaza buildings carried the paid billboard screens. With them gone
the city has no billboard slots, so walk mode shows no ads and offers none
for booking. The ad system (`ads/`, `workers/ads`, `walk/layout.ts` with the
screen IDs) is untouched; giving the towers screens again only needs
`TowerCity.billboards` to return slots.

## Not built yet

- Fast lifts are the destination panel and a travel screen, not cabins.
- Shutter sound (the hook is there, silent).
- Server-side signal snapshots, the D1 tables above, sponsored placements.
- Grouping presence by tower or floor.

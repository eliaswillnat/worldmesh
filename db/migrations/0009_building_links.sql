-- Buildings on worlds (docs/specs/buildings.md §5): which saved building stands
-- on which world's block in the hub city. A link is made by the building's
-- owner once the world's own worldmesh.json names the building, and shows in
-- the city only after a person approved it, pinned to the exact file they saw.

create table building_link (
  -- The world's canonical URL (lower-case host, no trailing slash or hash),
  -- as the hub compares world URLs. One world has at most one building.
  world_url text primary key,
  building_id text not null references building (id) on delete cascade,
  status text not null check (status in ('pending', 'approved', 'rejected', 'hidden')),
  -- SHA-256 (hex) of the file the reviewer's browser downloaded: visitors'
  -- browsers show the building only if theirs hashes the same.
  sha256 text,
  -- What the platform said the approved file was: the blob CID on AT
  -- Protocol, the GLB's size on Sketchfab. A different one sends the link back
  -- to review before anything is downloaded.
  version text,
  -- The portal face and fit the reviewer saw (§6), for the record.
  portal_json text,
  -- Shown to the owner when rejected or hidden.
  reason text,
  -- Last time the world's manifest was read and still named the building.
  checked_at integer not null,
  reviewed_at integer,
  reviewed_by text,
  created_at integer not null,
  updated_at integer not null
);

create index building_link_building_idx on building_link (building_id);
create index building_link_status_idx on building_link (status, created_at);

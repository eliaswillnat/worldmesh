-- My buildings (docs/specs/buildings.md §4.2): models a user saved to stand
-- in the hub city in place of their world's block. As with characters, only
-- pointers are stored: the model stays in the user's Sketchfab account or
-- AT Protocol repository, reached through the same avatar_connection.

create table building (
  -- 'bld_' and 16 random characters. The id a world's worldmesh.json names to
  -- show this building (step 3), so it is shown to its owner only.
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  connection_id text not null references avatar_connection (id) on delete cascade,
  provider text not null,
  -- Sketchfab model uid, or the at:// URI of a net.worldmesh.building record.
  external_id text not null,
  -- The platform's name, refreshed whenever it is saved again.
  display_name text,
  -- A name the user gave it here; wins over display_name.
  custom_name text,
  -- Provider-hosted image URL, for the UI only.
  thumbnail_url text,
  -- Size of the GLB, the model page and the like.
  metadata_json text,
  created_at integer not null,
  updated_at integer not null,
  unique (connection_id, external_id)
);

create index building_user_idx on building (user_id, created_at);

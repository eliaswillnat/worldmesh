-- Avatar Wallet: Sketchfab as a third provider (workers/auth/src/avatars/sketchfab.ts).
-- As with the others, only pointers are stored: the user's Sketchfab uid and
-- name, sealed OAuth tokens, and the uid of the model they picked.
--
-- SQLite cannot change a check constraint in place, so avatar_connection is
-- rebuilt. avatar is rebuilt alongside it: dropping avatar_connection while
-- avatar still referenced it would cascade-delete every selection.

create table avatar_connection_next (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  provider text not null check (provider in ('vroid', 'atproto', 'sketchfab')),
  -- VRoid Hub user id, the AT Protocol DID, or the Sketchfab user uid.
  provider_account_id text not null,
  -- VRoid Hub / Sketchfab display name, or the verified AT Protocol handle.
  display_name text,
  -- AT Protocol only: the PDS the avatar records and blobs are read from.
  service_endpoint text,
  -- VRoid and Sketchfab: access/refresh tokens, AES-GCM encrypted under the
  -- AVATAR_SECRET Worker secret. AT Protocol keeps none.
  token_enc text,
  status text not null default 'active' check (status in ('active', 'reconnect')),
  created_at integer not null,
  updated_at integer not null,
  unique (user_id, provider)
);

insert into avatar_connection_next
  (id, user_id, provider, provider_account_id, display_name, service_endpoint, token_enc, status, created_at, updated_at)
select id, user_id, provider, provider_account_id, display_name, service_endpoint, token_enc, status, created_at, updated_at
from avatar_connection;

create table avatar_next (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  connection_id text not null references avatar_connection_next (id) on delete cascade,
  provider text not null,
  -- VRoid Hub character model id, the at:// URI of an app.at3d.avatar record,
  -- or a Sketchfab model uid.
  external_avatar_id text not null,
  display_name text,
  -- Provider-hosted image URL, for the wallet UI only.
  thumbnail_url text,
  format text not null check (format in ('vrm', 'glb', 'gltf')),
  selected integer not null default 0 check (selected in (0, 1)),
  metadata_json text,
  created_at integer not null,
  updated_at integer not null,
  unique (connection_id, external_avatar_id)
);

insert into avatar_next
  (id, user_id, connection_id, provider, external_avatar_id, display_name, thumbnail_url, format, selected, metadata_json, created_at, updated_at)
select id, user_id, connection_id, provider, external_avatar_id, display_name, thumbnail_url, format, selected, metadata_json, created_at, updated_at
from avatar;

drop table avatar;
drop table avatar_connection;
-- Renaming also points avatar_next's foreign key at the new name.
alter table avatar_connection_next rename to avatar_connection;
alter table avatar_next rename to avatar;

create unique index avatar_selected_idx on avatar (user_id) where selected = 1;

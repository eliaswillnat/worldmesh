-- Avatar Wallet (workers/auth, src/avatars). WorldMesh stores pointers to
-- avatars that stay hosted by the provider (VRoid Hub, the user's own AT
-- Protocol PDS). No model files, textures or other avatar binaries are ever
-- stored here or anywhere else WorldMesh runs.
--
-- Independent of ActivityPub: nothing in federation reads these tables.

-- A provider account a user connected. One per provider per user.
create table avatar_connection (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  provider text not null check (provider in ('vroid', 'atproto')),
  -- VRoid Hub user id, or the AT Protocol DID.
  provider_account_id text not null,
  -- VRoid Hub display name, or the verified AT Protocol handle.
  display_name text,
  -- AT Protocol only: the PDS the avatar records and blobs are read from.
  service_endpoint text,
  -- VRoid only: access/refresh tokens, AES-GCM encrypted under the
  -- AVATAR_SECRET Worker secret. AT Protocol reads are public, so its tokens
  -- are discarded (and revoked) as soon as the DID is verified.
  token_enc text,
  -- 'reconnect' once the provider refused a refresh; the UI asks to reconnect.
  status text not null default 'active' check (status in ('active', 'reconnect')),
  created_at integer not null,
  updated_at integer not null,
  unique (user_id, provider)
);

-- Avatars a user picked. Listings are read live from the provider; a row
-- exists only for a chosen avatar, and at most one per user is selected.
create table avatar (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  connection_id text not null references avatar_connection (id) on delete cascade,
  provider text not null,
  -- VRoid Hub character model id, or the at:// URI of an app.at3d.avatar record.
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

create unique index avatar_selected_idx on avatar (user_id) where selected = 1;

-- WorldMesh's own data, keyed to Better Auth's "user" table.
--
-- Not duplicated here: name, email and avatar (user.name / user.email /
-- user.image, refreshed from the OAuth provider) and the username
-- (user.username, so it rides along in the session cookie cache).
-- Timestamps in WorldMesh tables are unix milliseconds.

-- Optional public creator details. A row exists once a user claims a username.
create table profile (
  user_id text primary key references "user" (id) on delete cascade,
  bio text,
  website_url text,
  -- Overrides user.image when set (a WorldMesh-hosted avatar, later).
  avatar_url text,
  created_at integer not null,
  updated_at integer not null
);

-- Worlds owned by a user. The public directory still reads the KV listing in
-- apps/hub/functions/api/worlds.ts; this table is where owned worlds live
-- once submissions move to accounts. Nothing is copied here automatically.
create table world (
  id text primary key,
  owner_user_id text references "user" (id) on delete set null,
  name text not null,
  url text not null unique,
  description text,
  cover_url text,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'published', 'removed')),
  -- The KV directory id this row corresponds to, if any.
  legacy_id text unique,
  created_at integer not null,
  updated_at integer not null,
  published_at integer
);

create index world_owner_idx on world (owner_user_id);
create index world_status_published_idx on world (status, published_at desc);

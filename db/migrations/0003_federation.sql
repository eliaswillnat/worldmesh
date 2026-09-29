-- ActivityPub federation (workers/federation). D1 stays canonical: these tables
-- only hold what federation needs on top of it — keys, followers, the
-- activities we published, delivery state, and received-activity dedup.

-- Local actors. A creator (kind 'person') gets one when federation first needs
-- it, which is only after they have claimed a username. 'application' is the
-- single instance actor that signs server-to-server fetches. 'world' is
-- reserved for worlds becoming actors later.
create table ap_actor (
  id text primary key,                  -- opaque; the actor URI is /ap/actors/{id}
  kind text not null check (kind in ('person', 'application', 'world')),
  user_id text unique references "user" (id) on delete cascade,
  world_id text unique references world (id) on delete cascade,
  public_key_pem text not null,
  -- AES-GCM encrypted PKCS#8, keyed from the FEDERATION_KEY_SECRET Worker
  -- secret. A copy of D1 alone cannot sign as anyone.
  private_key_enc text not null,
  created_at integer not null,
  check ((kind = 'person') = (user_id is not null)),
  check ((kind = 'world') = (world_id is not null))
);

-- Cache of remote actors we have verified signatures from or deliver to.
-- Always upsert (on conflict do update), never `insert or replace`: a
-- replace deletes the row first, and the delete cascades to ap_follower.
create table ap_remote_actor (
  uri text primary key,
  host text not null,
  inbox text not null,
  shared_inbox text,
  key_id text not null,
  public_key_pem text not null,
  fetched_at integer not null
);

-- Incoming signatures name a key, not an actor.
create index ap_remote_actor_key_idx on ap_remote_actor (key_id);

create table ap_follower (
  actor_id text not null references ap_actor (id) on delete cascade,
  follower_uri text not null references ap_remote_actor (uri) on delete cascade,
  follow_activity_id text not null,
  created_at integer not null,
  primary key (actor_id, follower_uri)
);

create index ap_follower_follow_idx on ap_follower (follow_activity_id);

-- Public objects we author, e.g. the Note announcing a newly published world.
create table ap_object (
  id text primary key,                  -- /ap/objects/{id}
  actor_id text not null references ap_actor (id) on delete cascade,
  -- One announcement per world, which makes announcing idempotent.
  world_id text unique references world (id) on delete set null,
  type text not null,
  json text not null,
  published_at integer not null
);

-- Activities we author: Create (public, listed in the outbox) and Accept
-- (not public, only delivered).
create table ap_activity (
  id text primary key,                  -- /ap/activities/{id}
  actor_id text not null references ap_actor (id) on delete cascade,
  type text not null,
  object_id text references ap_object (id) on delete cascade,
  public integer not null default 0,
  json text not null,
  published_at integer not null
);

create index ap_activity_outbox_idx on ap_activity (actor_id, public, published_at desc);

-- Outgoing deliveries: one row per (activity, inbox). A row is deleted once
-- delivered or given up on. The same (activity, inbox) pair is what a
-- Cloudflare Queue message would carry, if delivery moves to a queue.
create table ap_delivery (
  id integer primary key autoincrement,
  activity_id text not null references ap_activity (id) on delete cascade,
  inbox text not null,
  attempts integer not null default 0,
  next_attempt_at integer not null,
  last_error text,
  created_at integer not null,
  unique (activity_id, inbox)
);

create index ap_delivery_due_idx on ap_delivery (next_attempt_at);

-- Every accepted inbox activity id, for de-duplication and replay protection.
-- Pruned after 14 days, well beyond the 12-hour signature window.
create table ap_inbox_seen (
  activity_id text primary key,
  actor_uri text not null,
  type text not null,
  received_at integer not null
);

create index ap_inbox_seen_received_idx on ap_inbox_seen (received_at);

-- Likes, boosts and replies from the fediverse on our objects. Only
-- references are kept, never remote content.
create table ap_interaction (
  activity_id text primary key,         -- the remote Like/Announce, or the reply's id
  object_id text not null references ap_object (id) on delete cascade,
  actor_uri text not null,
  type text not null check (type in ('Like', 'Announce', 'Reply')),
  created_at integer not null
);

create index ap_interaction_object_idx on ap_interaction (object_id, type);
create index ap_interaction_actor_idx on ap_interaction (actor_uri);

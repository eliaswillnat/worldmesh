-- Paid billboard advertisements in the hub's walk-mode city (workers/ads).
--
-- One row per submission. Only workers/ads writes here, and only through the
-- status transitions guarded below: nothing a browser sends can set a status.
-- Timestamps are unix milliseconds, like the rest of WorldMesh's own tables.

create table ad_submission (
  id text primary key,                      -- random, 128 bits (base32)
  billboard_id text not null,               -- e.g. 'f07-main'; see apps/hub/src/walk/layout.ts
  status text not null check (status in
    ('awaiting_payment', 'pending', 'approved', 'active', 'rejected', 'expired', 'cancelled', 'failed')),
  -- Why it reached its status, e.g. 'authorization_expired', 'run_ended', 'abandoned'.
  status_reason text,

  media_type text not null check (media_type in ('image', 'video')),
  media_mime text not null check (media_mime in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  media_key text not null,                  -- R2 object key: ads/<id>/<random>.<ext>
  media_bytes integer not null check (media_bytes > 0),
  poster_key text,                          -- video still frame (JPEG), if any
  media_deleted_at integer,

  advertiser_name text not null check (length(advertiser_name) between 1 and 80),
  destination_url text not null check (destination_url like 'https://%' and length(destination_url) <= 2048),
  contact_email text not null check (length(contact_email) <= 254),

  -- SHA-256 of the token only the submitting browser holds (confirm/cancel).
  manage_token_hash text not null,
  -- Keyed hash of the submitter's IP, to cap unpaid holds per client. Not the IP.
  client_hash text,

  stripe_payment_intent_id text unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null,
  -- Last PaymentIntent status seen from Stripe itself (API or verified webhook).
  payment_status text,
  payment_error text,

  created_at integer not null,              -- the submission date
  updated_at integer not null,
  hold_expires_at integer,                  -- awaiting_payment: the billboard is held until then
  authorized_at integer,
  authorization_expires_at integer,         -- pending: cancel before the card authorization lapses
  reviewed_at integer,
  reviewed_by text,                         -- admin email
  reject_reason text,
  captured_at integer,
  activated_at integer,                     -- the activation date
  ends_at integer,
  closed_at integer,                        -- entered a final status
  admin_notified_at integer,
  advertiser_notified_at integer,

  -- Nothing reaches the billboard without the money having been captured.
  check (status <> 'active' or (captured_at is not null and activated_at is not null and ends_at is not null)),
  check (status <> 'pending' or authorized_at is not null),
  check (status <> 'awaiting_payment' or hold_expires_at is not null)
);

-- The reservation: at most one live submission per billboard. Two people
-- racing for the same screen cannot both get past this, whatever the timing.
-- Keep the status list in step with LIVE_STATUSES in apps/hub/src/ads/config.ts.
create unique index ad_submission_live_billboard_uq on ad_submission (billboard_id)
  where status in ('awaiting_payment', 'pending', 'approved', 'active');

create index ad_submission_status_idx on ad_submission (status, updated_at);
create index ad_submission_client_idx on ad_submission (client_hash, status);

-- Only these moves are possible. Anything else, from any code path, aborts.
create trigger ad_submission_status_guard
before update of status on ad_submission
when old.status <> new.status and not (
     (old.status = 'awaiting_payment' and new.status in ('pending', 'cancelled'))
  or (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'cancelled'))
  or (old.status = 'approved' and new.status in ('active', 'pending', 'failed'))
  or (old.status = 'active' and new.status = 'expired')
)
begin
  select raise(abort, 'ad_submission: illegal status transition');
end;

-- Stripe webhook events already handled, so a redelivery is a no-op.
create table ad_stripe_event (
  id text primary key,                      -- evt_...
  type text not null,
  received_at integer not null
);

create index ad_stripe_event_received_idx on ad_stripe_event (received_at);

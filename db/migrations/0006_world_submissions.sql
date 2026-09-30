-- World submissions move from KV into the world table (workers/auth,
-- src/worlds.ts). A submission is a 'pending' row, owned by the signed-in
-- user who sent it; approving it makes it 'published', which is what the
-- public directory (GET /api/worlds) lists.

-- Shown on the world card. Free text from the submitter, not the account name.
alter table world add column creator_name text;
alter table world add column portfolio_url text;
-- Where to write about this world when it has no owner (a guest submission,
-- or a world imported from KV/community.json). Owned worlds use user.email.
alter table world add column contact_email text;
-- Where the row came from: 'submitted' through the hub form, or copied in
-- from the old stores by scripts/backfill-worlds.mjs ('kv', 'community').
alter table world add column source text not null default 'submitted';
-- SHA-256 (hex) of the one-time token in the approval email. Cleared on approval.
alter table world add column review_token_hash text;

create index world_status_created_idx on world (status, created_at desc);

-- Reports on buildings in the hub city (docs/specs/buildings.md §8): a
-- signed-in visitor flags a building standing on a world's block; reviewers
-- see open reports in the admin dashboard and on the review page, and either
-- hide the building or dismiss the reports.

create table building_report (
  -- 'rpt_' and 16 random characters.
  id text primary key,
  world_url text not null,
  building_id text not null references building (id) on delete cascade,
  -- The approved file that was standing when it was reported.
  sha256 text,
  reporter_id text references "user" (id) on delete set null,
  reason text not null check (reason in ('offensive', 'sexual', 'violent', 'copyright', 'broken', 'other')),
  -- What the reporter added, up to 500 characters.
  note text,
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at integer not null,
  resolved_at integer,
  resolved_by text
);

-- One open report per person per building on a world.
create unique index building_report_once on building_report (world_url, building_id, reporter_id) where status = 'open';
create index building_report_open_idx on building_report (status, world_url);

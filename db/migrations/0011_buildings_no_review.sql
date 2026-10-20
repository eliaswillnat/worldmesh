-- Buildings stand on their worlds without review first (docs/specs/buildings.md
-- §5.2): links still waiting for a reviewer go up as they are. One sent back
-- because its file changed loses the stale pin, so the new file stands.
update building_link
set status = 'approved', sha256 = null, version = null, reason = null, updated_at = cast((julianday('now') - 2440587.5) * 86400000 as integer)
where status = 'pending';

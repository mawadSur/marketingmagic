-- marketingmagic · 065 — hot path composite index (queue page optimization)
--
-- The /queue page's primary query filters posts by (workspace_id, status IN (...))
-- and orders by scheduled_at ASC. This is a high-traffic read path (the queue is
-- the user's primary workflow page, visited on every approval/edit cycle). The
-- existing posts_workspace_status_idx covers (workspace_id, status) but does NOT
-- include scheduled_at, forcing Postgres to sort the filtered rows. The partial
-- index posts_scheduled_at_idx only helps for status='scheduled' (not the
-- 'pending_approval' rows that share the same query).
--
-- This composite index allows Postgres to:
--   1. Seek directly to the workspace_id
--   2. Filter to the two status values ('pending_approval', 'scheduled')
--   3. Return rows already sorted by scheduled_at (eliminating the sort step)
--
-- Write-amplification cost: acceptable. The posts table write rate is moderate
-- (one insert per generated post, one update on approval/publish), and the queue
-- page is a genuine hot path that benefits from index-only scans.

create index if not exists posts_workspace_status_scheduled_idx
  on public.posts (workspace_id, status, scheduled_at);

-- marketingmagic · 007 — cross-channel post ideas
--
-- Phase 2 introduces the concept of a "post idea" — a single piece of content
-- that's been adapted into N channel-specific variants. Each variant is still
-- a row in `posts` (preserving the existing per-channel scheduling, approval,
-- and metrics flow), but variants belonging to the same idea share an
-- `idea_id` so the queue can group them and a single "approve all" action
-- can cascade.
--
-- Why text (not uuid):
--   The plan generator names ideas inline (one idea object that fans out to
--   variants) and the server action mints a UUID per idea at insert time.
--   Storing as text keeps us flexible — we could later let the generator
--   provide stable idea labels (e.g. "winner-week-3") rather than opaque
--   UUIDs without a schema change.
--
-- Backward-compat: idea_id is NULLABLE. Legacy / single-channel posts keep
-- idea_id IS NULL and the queue UI renders them as standalone rows exactly
-- as today.

alter table public.posts
  add column if not exists idea_id text;

-- Partial index — the queue groups by idea_id, but only when set. Skipping
-- nulls keeps the index tight (most legacy rows will never get an idea_id).
create index if not exists posts_idea_id_idx
  on public.posts(idea_id)
  where idea_id is not null;

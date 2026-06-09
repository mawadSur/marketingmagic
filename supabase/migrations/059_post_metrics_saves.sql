-- marketingmagic · 059 — post_metrics.saves (organic "saves" signal)
--
-- Adds a nullable `saves` column to public.post_metrics:
--
--   post_metrics.saves  int  (nullable)
--
-- WHY: "saves" is the PRIMARY optimization signal in the organic Hormozi
-- reframe — "double down on what your audience SAVES and buys" (see
-- docs/designs/hormozi-video-strategy-review.md, slice #1). dispatchMetrics
-- already fetches it for Instagram (UnifiedMetrics.saves, dispatch.ts:90 →
-- IG `saved` at :357), but post_metrics had no column for it, so the pull-
-- metrics cron silently dropped the value. This persists it end-to-end.
--
-- NULLABLE, NOT zero-defaulted: saves is IG-only today (TikTok metrics are a
-- stub; the other channels' APIs don't expose a save count). NULL means "this
-- channel doesn't report saves", which is semantically distinct from 0 ("the
-- channel reports saves and there were none"). Channels that don't populate
-- UnifiedMetrics.saves map to NULL on insert.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists`, no backfill — existing
-- rows get NULL (correct: we never had save data for them). Safe to re-run.
--
-- RLS: post_metrics already enforces workspace-scoped row-level security
-- (see 001_init.sql, "Members can read post metrics"). Adding a column
-- inherits the table's policies — no new policy is required. Documented here
-- so the absence isn't read as an oversight.

alter table public.post_metrics
  add column if not exists saves int;

comment on column public.post_metrics.saves is
  'Times the post was saved/bookmarked by viewers (migration 059). Instagram only today (UnifiedMetrics.saves ← IG `saved`); NULL on channels that do not report saves. The primary organic optimization signal in the Hormozi reframe — distinct from 0 ("reported, none") vs NULL ("not reported").';

-- marketingmagic · 027 — Video render quota (Phase 4 / P4)
--
-- Adds a third metered counter to usage_counters so the video pipeline can
-- be plan-gated the same way posts + AI images already are. The gating helper
-- assertWithinVideoQuota() (src/lib/billing/limits.ts) reads this column and
-- the increment helper incrementVideosGenerated() (src/lib/billing/usage.ts)
-- bumps it from the orchestrator AFTER MPT accepts a render.
--
-- We reuse the existing usage_counters table (one row per workspace+month)
-- rather than spin up a new table — a render is just another metered event,
-- and counting it alongside posts/images keeps /settings/billing's usage
-- panel a single read. RLS is unchanged: members can already SELECT their own
-- row (so the billing UI shows the bar); writes stay service-role only so
-- clients can't tamper with their own quota.

alter table public.usage_counters
  add column if not exists videos_generated integer not null default 0;

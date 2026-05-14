-- marketingmagic · 012 — Audience timezone (Phase 6.5 Smart Timing)
--
-- Smart-timing analysis buckets posts by (day-of-week × 2-hour window) and
-- needs to know *whose* clock to bucket in. We store the audience timezone
-- on brand_briefs rather than workspaces because:
--
--   • Voice + audience are already on the brief (one settings page).
--   • A workspace might evolve audiences across plans without changing
--     ownership/billing/etc on the workspaces row.
--   • brand_briefs has 1:1 with workspaces in practice, so the cardinality
--     matches and joins are free.
--
-- The value is an IANA timezone identifier (e.g. "America/New_York"). NULL or
-- the literal default "UTC" both mean "no preference"; the analyzer falls
-- back to UTC bucketing.

alter table public.brand_briefs
  add column if not exists audience_timezone text not null default 'UTC';

comment on column public.brand_briefs.audience_timezone is
  'IANA timezone identifier used by Phase 6.5 Smart Timing to bucket posts. Default: UTC.';

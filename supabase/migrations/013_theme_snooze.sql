-- marketingmagic · 013 — Theme-aware calendar gaps (Phase 6.9)
--
-- Adds two columns to brand_briefs:
--
--   theme_snooze         jsonb  — array of per-theme preferences, each entry
--                                 shaped as one of:
--                                   { "theme": "<tag>", "snoozed_until": "<iso>" }
--                                   { "theme": "<tag>", "archived": true }
--                                 Read/written by src/lib/themes/preferences.ts.
--                                 The gap-detection cron filters out snoozed
--                                 (until snoozed_until elapses) and archived
--                                 themes so customers can intentionally drop
--                                 themes without being nagged.
--
--   theme_gaps_enabled   bool   — workspace opt-out. Default true: gap
--                                 detection runs and the dashboard widget +
--                                 digest sections render when neglected
--                                 themes exist. Set false to disable both
--                                 the cron-side work and the UI surfaces.
--
-- Storing snooze state on brand_briefs (rather than a new table) keeps this
-- migration small and matches how pending_voice_diff is colocated. Themes
-- are workspace-scoped strings so the array-of-objects shape is fine for
-- expected cardinalities (rarely > 20 themes per workspace).

alter table public.brand_briefs
  add column if not exists theme_snooze jsonb not null default '[]'::jsonb,
  add column if not exists theme_gaps_enabled boolean not null default true;

comment on column public.brand_briefs.theme_snooze is
  'Phase 6.9: array of { theme, snoozed_until? , archived? } entries. Filters out themes from gap-detection.';

comment on column public.brand_briefs.theme_gaps_enabled is
  'Phase 6.9: workspace opt-out for neglected-theme detection. Default true.';

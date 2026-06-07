-- marketingmagic · 050 — audio_retention_opt_in (Phase 2.6 finish)
--
-- Renames the Founder-Mode raw-audio retention preference to its final,
-- product-facing name and tightens the documented retention window.
--
--   brand_briefs.audio_retention_opt_in  bool not null default false
--
--     false (DEFAULT)  → raw voice-memo audio is deleted immediately after
--                        Whisper transcription completes. Only the transcript
--                        persists (as a `sources` row). This is the privacy-
--                        preserving default and matches the pricing-page
--                        promise "we don't keep your audio".
--     true             → the raw audio blob is retained in the private
--                        `founder-audio` Storage bucket (workspace-scoped
--                        path) for 30 days, then deleted by the retention
--                        cron. Opt-in only — voice memos are PII-heavy.
--
-- WHY A RENAME (not a new column): migration 015 shipped this preference as
-- `keep_raw_audio`. The Phase-2.6 finish standardises the name on
-- `audio_retention_opt_in` (consistent with the other *_opt_in / *_enabled
-- toggles on the table) and there must be exactly ONE source of truth — a
-- second boolean with identical meaning would split-brain the /record
-- read path. We therefore RENAME in place (preserving every workspace's
-- existing opt-in value) rather than add-and-deprecate.
--
-- The 90→30 day window is a documentation/cron change only; the Storage
-- bucket lifecycle is dashboard-managed (see 015 header) and the operator
-- must set the bucket lifecycle to 30 days to match. The application-side
-- retention-enforcement cron is a follow-up (see TODO in
-- src/lib/voice-memo/retention.ts).
--
-- ADDITIVE + IDEMPOTENT: safe to re-run. We guard the rename so a fresh DB
-- (where 015 created `keep_raw_audio`) and an already-migrated DB both
-- converge to the same end state, and we backfill the new column from the
-- old one if both happen to coexist.

do $$
begin
  -- Case 1 — the pre-rename column still exists: rename it in place. This
  -- preserves the not-null + default-false constraint and every workspace's
  -- existing opt-in value.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'brand_briefs'
      and column_name = 'keep_raw_audio'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'brand_briefs'
      and column_name = 'audio_retention_opt_in'
  ) then
    alter table public.brand_briefs
      rename column keep_raw_audio to audio_retention_opt_in;
  end if;

  -- Case 2 — neither exists (a DB that somehow skipped 015): create fresh.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'brand_briefs'
      and column_name = 'audio_retention_opt_in'
  ) then
    alter table public.brand_briefs
      add column audio_retention_opt_in boolean not null default false;
  end if;

  -- Case 3 — both columns exist (a partial / re-applied migration): keep the
  -- canonical column, backfilling any true value from the legacy one, then
  -- drop the legacy column so there is a single source of truth.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'brand_briefs'
      and column_name = 'keep_raw_audio'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'brand_briefs'
      and column_name = 'audio_retention_opt_in'
  ) then
    update public.brand_briefs
      set audio_retention_opt_in = audio_retention_opt_in or keep_raw_audio;
    alter table public.brand_briefs
      drop column keep_raw_audio;
  end if;
end $$;

comment on column public.brand_briefs.audio_retention_opt_in is
  'Phase 2.6: opt-in to retain raw voice-memo audio in the founder-audio Storage bucket for 30 days after transcription. Default false (audio deleted immediately post-transcription).';

-- RLS: brand_briefs already enforces workspace-scoped row-level security
-- (see 001_init.sql). A column add/rename inherits the table's policies —
-- no new policy is required. Documented here so the absence isn't read as
-- an oversight.

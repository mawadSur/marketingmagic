-- marketingmagic · 015 — Founder Mode raw-audio retention (Phase 2.6)
--
-- Adds one column to brand_briefs:
--
--   keep_raw_audio   bool   — opt-in to retain the raw audio blob in Supabase
--                             Storage after Whisper transcription completes.
--                             Default false: audio bytes are discarded once
--                             the transcript is returned, and only the
--                             transcript persists as a `sources` row.
--                             When true: audio uploads to the
--                             `founder-audio` Storage bucket (workspace-
--                             scoped path) with a 90-day lifecycle.
--
-- Why opt-in (not opt-out): voice memos are PII-heavy and the default
-- product promise on the pricing page is "we don't keep your audio." The
-- toggle exists for users who later want voice-cloning fine-tuning (the
-- deferred Phase 7 voice-clone feature).
--
-- Storage bucket setup is NOT done in this migration — Supabase Storage
-- buckets are dashboard-managed in this project. Operator must:
--   1. Create bucket `founder-audio`, private (no public read).
--   2. Set lifecycle: delete objects > 90 days.
--   3. Add RLS policy: only workspace members can read their own
--      workspace's path prefix (`<workspace_id>/...`).
--   4. Add RLS policy: only authenticated users with service-role can
--      delete (so the daily cleanup cron retains the only delete path).
-- The /record page will write to this bucket only when keep_raw_audio=true.

alter table public.brand_briefs
  add column if not exists keep_raw_audio boolean not null default false;

comment on column public.brand_briefs.keep_raw_audio is
  'Phase 2.6: opt-in to retain raw voice-memo audio in the founder-audio Storage bucket after transcription. Default false (audio discarded post-transcription).';

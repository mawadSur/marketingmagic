-- marketingmagic · 006 — Voice profile (Phase 1: Voice Wedge)
--
-- Sharpens voice fidelity so plan-generated drafts sound like the customer,
-- not like generic AI. Four schema concerns in this migration:
--
-- 1. brand_briefs gains `voice_profile` (jsonb) — extracted from reference
--    posts via a Claude tool-use call. Shape is documented in
--    src/lib/voice/schema.ts (VoiceProfile zod).
--
-- 2. brand_briefs gains `pending_voice_diff` (jsonb) — accumulated by the
--    weekly evolution cron from recent rejection reasons. Users accept or
--    dismiss the diff in /settings/brief; on accept we merge into
--    voice_profile and null this out.
--
-- 3. posts gains `voice_score` (numeric, 0-100) and `low_confidence` (bool).
--    These are first-class columns — NOT stuffed into generation_metadata —
--    because the auto-regenerate logic and dashboards filter on them.
--
-- 4. approvals gains `reason` + `reason_note` so /queue can capture
--    structured rejection feedback for the prompt-injection feedback loop.

-- ─────────────────────────────────────────────────────────────
-- brand_briefs — voice profile fields
-- ─────────────────────────────────────────────────────────────
alter table public.brand_briefs
  add column if not exists voice_profile jsonb,
  add column if not exists voice_profile_extracted_at timestamptz,
  add column if not exists pending_voice_diff jsonb,
  add column if not exists pending_voice_diff_at timestamptz;

-- ─────────────────────────────────────────────────────────────
-- posts — voice scoring
-- ─────────────────────────────────────────────────────────────
alter table public.posts
  add column if not exists voice_score numeric(5,2)
    check (voice_score is null or (voice_score >= 0 and voice_score <= 100)),
  add column if not exists low_confidence boolean not null default false;

-- Index so the dashboard "needs-review" filter is cheap.
create index if not exists posts_low_confidence_idx
  on public.posts(workspace_id)
  where low_confidence = true;

-- ─────────────────────────────────────────────────────────────
-- approvals — structured rejection reason
-- ─────────────────────────────────────────────────────────────
-- reason enum mirrors the radio options in /queue (queue-row.tsx).
-- Only set when action = 'rejected'; nullable for backward compat with
-- all existing approve/edit/unapprove rows.
alter table public.approvals
  add column if not exists reason text
    check (reason is null or reason in ('off_voice', 'wrong_theme', 'factually_wrong', 'other')),
  add column if not exists reason_note text
    check (reason_note is null or char_length(reason_note) <= 500);

-- Cheap lookups by reason for the rejection-signals aggregator.
create index if not exists approvals_reason_idx
  on public.approvals(action, reason)
  where reason is not null;

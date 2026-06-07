-- marketingmagic · 048 — Shadow Mode for Autonomous Community Engagement (Bet 4)
--
-- Adds a SAFE MIDDLE STATE between OFF and live-send for both autonomous paths:
-- the public auto-reply (migration 045) and the comment→DM lead capture
-- (migration 046). In SHADOW mode the AI fully generates what it WOULD send and
-- records it for operator review, but NEVER posts and NEVER flips the
-- interaction. Zero public blast radius — the operator inspects the drafts
-- before flipping the account to 'live'.
--
-- ─────────────────────────────────────────────────────────────
-- TRI-STATE MODEL — replacing the on/off booleans with 'off' | 'shadow' | 'live'
--
-- Migrations 045/046 modelled engagement as two booleans
-- (social_accounts.auto_reply_enabled, social_accounts.dm_capture_enabled).
-- That can't express the shadow middle state, so we introduce two TEXT enum
-- columns:
--
--   social_accounts.auto_reply_mode   text  'off' | 'shadow' | 'live'  default 'off'
--   social_accounts.dm_capture_mode   text  'off' | 'shadow' | 'live'  default 'off'
--
-- The MODE columns are the new source of truth (read by the policy gate +
-- orchestrators). We KEEP the original boolean columns for backward-compat
-- (nothing that still reads them breaks) and keep them in sync from app code:
-- a boolean is TRUE iff its mode is 'live'. A 'shadow' account therefore reads
-- as enabled=false to any legacy boolean reader — fail-safe, since a stray old
-- reader treats shadow as "not sending", never as "sending".
--
-- BACKFILL: existing enabled=TRUE → mode='live', enabled=FALSE → mode='off',
-- so live accounts keep sending and off accounts keep holding with no change in
-- behaviour the moment this migration applies.
--
-- ─────────────────────────────────────────────────────────────
-- AUDIT — shadow output must be reviewable.
--   * The auto_reply_log + dm_capture_log outcome CHECK constraints gain a
--     'shadow' value (a shadow attempt is audited, never sent).
--   * Each log table gains a nullable would_send_text column holding the exact
--     draft the AI WOULD have sent, so the operator can review shadow output.
--     (The existing reply_text / dm_text columns already hold the draft too;
--     would_send_text is the dedicated, explicitly-nullable shadow surface.)
-- ─────────────────────────────────────────────────────────────
--
-- This migration adds NO new env vars and reuses the existing RLS / indexes.

-- ── 1. Tri-state mode columns on social_accounts ─────────────────────────
-- Default 'off' — conservative by construction, identical posture to the
-- enabled=false default in 045/046.
alter table public.social_accounts
  add column if not exists auto_reply_mode text not null default 'off'
    check (auto_reply_mode in ('off', 'shadow', 'live'));

alter table public.social_accounts
  add column if not exists dm_capture_mode text not null default 'off'
    check (dm_capture_mode in ('off', 'shadow', 'live'));

comment on column public.social_accounts.auto_reply_mode is
  'Bet 4 (048): tri-state auto-reply engagement — off | shadow | live. Shadow drafts + audits but NEVER sends/flips. Source of truth; the legacy auto_reply_enabled boolean is kept in sync (true iff live). Requires trust_mode to engage.';

comment on column public.social_accounts.dm_capture_mode is
  'Bet 4 (048): tri-state comment→DM engagement — off | shadow | live. Shadow drafts + audits but NEVER DMs/tags/flips. Source of truth; the legacy dm_capture_enabled boolean is kept in sync (true iff live). Independent of auto_reply_mode.';

-- ── 2. Backfill mode from the existing booleans ──────────────────────────
-- TRUE → 'live' (keep sending), FALSE → 'off' (keep holding). Idempotent: a
-- re-run only re-derives from the same booleans. Existing behaviour preserved.
update public.social_accounts
  set auto_reply_mode = case when auto_reply_enabled then 'live' else 'off' end
  where auto_reply_mode = 'off';

update public.social_accounts
  set dm_capture_mode = case when dm_capture_enabled then 'live' else 'off' end
  where dm_capture_mode = 'off';

-- ── 3. Add 'shadow' to the auto_reply_log outcome CHECK ──────────────────
-- A shadow attempt is recorded as outcome='shadow' (drafted, audited, NOT sent,
-- interaction NOT flipped). The rate cap only counts outcome='sent', so shadow
-- never consumes rate budget — shadow is unlimited (it never hits the platform).
alter table public.auto_reply_log
  drop constraint if exists auto_reply_log_outcome_check;
alter table public.auto_reply_log
  add constraint auto_reply_log_outcome_check
    check (outcome in ('sent', 'shadow', 'blocked', 'failed'));

-- The exact reply the AI WOULD have sent, for shadow rows (operator review).
-- Nullable: populated only when outcome='shadow'. The existing reply_text
-- column also carries the draft (it's NOT NULL with a 1..3000 CHECK); this is
-- the dedicated, explicitly-nullable shadow-output surface.
alter table public.auto_reply_log
  add column if not exists would_send_text text
    check (would_send_text is null or length(would_send_text) between 1 and 3000);

comment on column public.auto_reply_log.would_send_text is
  'Bet 4 (048): for outcome=''shadow'', the exact reply the AI WOULD have sent (NOT posted). Null for sent/blocked/failed rows.';

-- ── 4. Add 'shadow' to the dm_capture_log outcome CHECK ──────────────────
alter table public.dm_capture_log
  drop constraint if exists dm_capture_log_outcome_check;
alter table public.dm_capture_log
  add constraint dm_capture_log_outcome_check
    check (outcome in ('sent', 'shadow', 'blocked', 'failed', 'scope_missing'));

-- The exact DM the AI WOULD have sent, for shadow rows (operator review).
alter table public.dm_capture_log
  add column if not exists would_send_text text
    check (would_send_text is null or length(would_send_text) between 1 and 3000);

comment on column public.dm_capture_log.would_send_text is
  'Bet 4 (048): for outcome=''shadow'', the exact DM the AI WOULD have sent (NOT messaged). Null for sent/blocked/failed/scope_missing rows.';

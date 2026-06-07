-- marketingmagic · 046 — Comment→DM Lead Capture (Bet 4, X/Bluesky/LinkedIn slice)
--
-- Completes the autonomous-community feature begun in migration 045. Where 045
-- auto-SENDS a public REPLY on a trusted channel, this migration adds the
-- comment→DM path: when an inbound comment/mention matches a workspace keyword
-- rule (e.g. "pricing", "demo"), we send the author a DIRECT MESSAGE with a
-- configured link and tag the interaction as a captured lead in post_outcomes.
--
-- ─────────────────────────────────────────────────────────────
-- SAFETY POSTURE — auto-DMing a STRANGER is higher blast-radius than the
-- public reply auto-send (a private, unsolicited message reads as spam and can
-- get the account flagged). So this slice is even more conservative than 045:
--
--   * Everything OFF by default. The new opt-in column dm_capture_enabled
--     defaults FALSE. Auto-DM requires (trust_mode AND dm_capture_enabled).
--     trust_mode alone (auto-publish trust) does NOT enable auto-DM.
--   * We REUSE the workspace kill switch from 045 (workspaces
--     .auto_reply_kill_switch). When killed, NEITHER auto-reply NOR auto-DM
--     fires for any account — one lever stops all autonomous community sends.
--     We do NOT invent a second kill switch.
--   * Each channel's DM send is guarded at RUNTIME by a real capability check
--     (X dm.write — paid tier; LinkedIn messaging — partnership-gated; Bluesky
--     chat.bsky.* — proxy header + recipient opt-in). When the capability is
--     absent the send is a clean, audited no-op (outcome='scope_missing'),
--     never a throw. See src/lib/interactions/errors.ts (DmScopeMissingError).
--   * A per-platform DM rate cap (enforced in app code against the new log,
--     LOWER than the reply caps in 045) bounds auto-DMs per account per hour.
--   * Every auto-DM attempt — sent / blocked / failed / scope_missing — is
--     written to dm_capture_log (audit trail + the source the rate cap counts).
--   * post_outcomes (migration 042) already exists on this branch; the app
--     keeps a defensive guard around the lead-tag write regardless.
-- ─────────────────────────────────────────────────────────────
--
-- This migration adds NO new env vars; auto-DM reuses the credentials already
-- stored on social_accounts and the existing CRON_SECRET bearer.

-- ── 1. Per-account opt-in ────────────────────────────────────────────────
-- Auto-DM is gated on (trust_mode AND dm_capture_enabled). A SEPARATE opt-in
-- from 045's auto_reply_enabled: a workspace may want auto-replies but NOT
-- auto-DMs (or vice versa). Defaults FALSE — conservative by construction.
alter table public.social_accounts
  add column if not exists dm_capture_enabled boolean not null default false;

comment on column public.social_accounts.dm_capture_enabled is
  'Bet 4 (046): per-account opt-in for the comment→DM lead-capture path. Auto-DM requires (trust_mode AND dm_capture_enabled). Defaults false — independent of auto_reply_enabled and of auto-publish trust.';

-- ── 2. Per-account keyword→DM rule ───────────────────────────────────────
-- The workspace's lead rule for this account: which keywords mark a comment as
-- lead intent, the link we DM back, and an optional cents value to attribute to
-- the captured lead. Stored as JSONB (not separate columns) because it's a
-- single small config blob edited as a unit in settings, and the keyword list
-- is variable-length. NULL = no rule configured → the comment→DM path no-ops
-- for this account even when the opt-in is on.
--
-- Shape (validated in app code, see src/lib/interactions/auto-reply/lead-capture.ts):
--   { "keywords": ["pricing","demo","how much"],
--     "link": "https://book.example.com/demo",
--     "valueCents": 0,
--     "message": "Hey! Thanks for asking — here's the link: {{link}}" }
alter table public.social_accounts
  add column if not exists lead_keyword_rule jsonb;

comment on column public.social_accounts.lead_keyword_rule is
  'Bet 4 (046): comment→DM keyword rule for this account — { keywords[], link, valueCents?, message? }. NULL = no rule, path no-ops. Validated/parsed in app code.';

-- ── 3. Audit log ─────────────────────────────────────────────────────────
-- One row per auto-DM attempt — sent / blocked / failed / scope_missing — so
-- an operator can see exactly what fired (or why nothing did). This is both the
-- audit trail and the source the DM rate-cap guard counts against (mirrors the
-- auto_reply_log design in 045; no separate rate-state table).
create table if not exists public.dm_capture_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  -- The inbound interaction whose comment matched a keyword rule. ON DELETE SET
  -- NULL so purging an interaction never erases the audit trail of what we sent.
  interaction_id uuid references public.interactions(id) on delete set null,
  channel text not null
    check (channel in ('x', 'bluesky', 'linkedin')),
  -- 'sent'          — DM was delivered to the platform.
  -- 'blocked'       — a guard (kill switch / not-trusted / not-opted-in /
  --                   no-rule / no-keyword-match / rate cap) prevented the send.
  -- 'failed'        — we attempted the send and the platform call errored.
  -- 'scope_missing' — the account lacks the DM capability/scope (e.g. X dm.write
  --                   not on this tier). Clean no-op, recorded for visibility.
  outcome text not null
    check (outcome in ('sent', 'blocked', 'failed', 'scope_missing')),
  -- Machine-readable reason. For 'blocked': kill_switch | not_trusted |
  -- not_opted_in | no_rule | no_keyword_match | rate_capped |
  -- channel_unsupported | already_actioned. For 'scope_missing': the gated
  -- scope (dm.write | linkedin_messaging | chat.bsky). For 'failed': the
  -- truncated platform error. For 'sent': the matched keyword.
  outcome_reason text,
  -- The keyword that matched (when one did), surfaced for the operator.
  matched_keyword text,
  -- The exact DM body we sent (or would have sent). Capped to match the reply
  -- length ceiling used by the manual composer.
  dm_text text not null check (length(dm_text) between 1 and 3000),
  -- Platform-native id of the DM/conversation we created, when outcome='sent'.
  external_id text,
  -- Did we successfully tag the lead into post_outcomes? Soft signal — a
  -- post_outcomes write miss never fails the DM send.
  lead_tagged boolean not null default false,
  created_at timestamptz not null default now()
);

-- Hot path: the rate-cap guard counts SENT auto-DMs for one account in the
-- trailing hour. Partial index on outcome='sent' keeps it tight, and the
-- (social_account_id, created_at) ordering covers the windowed count.
create index if not exists dm_capture_log_account_sent_idx
  on public.dm_capture_log (social_account_id, created_at desc)
  where outcome = 'sent';

-- Audit-browse path: the workspace's full auto-DM history, newest first.
create index if not exists dm_capture_log_workspace_created_idx
  on public.dm_capture_log (workspace_id, created_at desc);

alter table public.dm_capture_log enable row level security;

-- Mirror the auto_reply_log RLS style (migration 045): members read; writes go
-- through the service-role client in the cron (which bypasses RLS), but we keep
-- a member-scoped write policy for symmetry and a future in-app affordance.
create policy "Members can read dm_capture_log"
  on public.dm_capture_log for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write dm_capture_log"
  on public.dm_capture_log for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.dm_capture_log is
  'Bet 4 (046): audit trail of every comment→DM auto-send (sent/blocked/failed/scope_missing) on X, Bluesky, LinkedIn. Also the source the per-account hourly DM rate cap counts against.';

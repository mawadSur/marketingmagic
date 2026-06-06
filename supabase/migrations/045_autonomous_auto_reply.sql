-- marketingmagic · 045 — Autonomous Community Engagement (Bet 4, X/Bluesky/LinkedIn slice)
--
-- Extends the read-only reply inbox (migration 023) into an ACTIVE surface:
-- on channels a workspace has explicitly trusted, a drafted reply can be
-- AUTO-SENT by the poll-interactions cron instead of waiting on a human click.
--
-- ─────────────────────────────────────────────────────────────
-- SAFETY POSTURE — this feature auto-sends PUBLIC content addressed at a
-- named person. A bad auto-reply is a reputational incident. So:
--
--   * Everything is OFF by default. The new opt-in column defaults FALSE
--     and the kill switch defaults FALSE (= "not killed", i.e. allowed),
--     but auto-send still requires the per-account opt-in to be flipped ON.
--   * We REUSE the existing publishing trust model (social_accounts.trust_mode)
--     — the same boolean that gates auto-PUBLISH of outbound posts. We do NOT
--     invent a second trust concept. trust_mode is necessary but, on its own,
--     not sufficient: posting on your own timeline is a lower-risk act than
--     replying at a stranger, so auto-reply additionally requires the explicit
--     auto_reply_enabled opt-in below.
--   * IG / Threads are intentionally excluded: those reply paths are blocked
--     on Meta App Review (see src/lib/interactions/errors.ts). A CHECK on the
--     log table keeps the auto-send channel set to {x, bluesky, linkedin}.
--   * Every auto-sent reply is written to auto_reply_log (audit trail).
--   * A per-platform rate cap (enforced in app code against this log) bounds
--     how many auto-replies fire per account per hour, to stay under platform
--     anti-spam enforcement.
-- ─────────────────────────────────────────────────────────────
--
-- This migration adds NO new env vars; auto-send reuses the credentials
-- already stored on social_accounts and the existing CRON_SECRET bearer.

-- ── 1. Per-account opt-in ────────────────────────────────────────────────
-- Auto-send is gated on (trust_mode AND auto_reply_enabled). Splitting the
-- opt-in from trust_mode means turning on auto-PUBLISH never silently turns
-- on auto-REPLY — the user must consciously enable the riskier behaviour.
-- Defaults FALSE: conservative by construction.
alter table public.social_accounts
  add column if not exists auto_reply_enabled boolean not null default false;

comment on column public.social_accounts.auto_reply_enabled is
  'Bet 4: per-account opt-in for AUTO-SENDING drafted replies. Auto-send requires (trust_mode AND auto_reply_enabled). Defaults false — auto-publish trust does NOT imply auto-reply.';

-- ── 2. Per-workspace kill switch ─────────────────────────────────────────
-- A single hard stop. When TRUE, NO auto-replies fire for ANY account in the
-- workspace, regardless of per-account opt-in or trust_mode. Defaults FALSE
-- (= not killed). This is the "stop everything now" lever; the inbox /
-- settings UI surfaces it prominently.
alter table public.workspaces
  add column if not exists auto_reply_kill_switch boolean not null default false;

comment on column public.workspaces.auto_reply_kill_switch is
  'Bet 4: workspace-wide hard stop for autonomous auto-replies. TRUE = no account auto-sends, period. Defaults false.';

-- ── 3. Audit log ─────────────────────────────────────────────────────────
-- One row per auto-sent reply (and per auto-send that was BLOCKED by a guard,
-- so the operator can see why nothing fired). This is both the audit trail and
-- the source of truth the rate-cap guard counts against — no separate
-- rate-state table to keep consistent.
create table if not exists public.auto_reply_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  -- The inbound interaction we auto-replied to. ON DELETE SET NULL so purging
  -- an interaction never erases the audit trail of what we sent.
  interaction_id uuid references public.interactions(id) on delete set null,
  channel text not null
    check (channel in ('x', 'bluesky', 'linkedin')),
  -- 'sent'      — reply was delivered to the platform.
  -- 'blocked'   — a guard (kill switch / not-trusted / not-opted-in / rate cap)
  --               prevented the send. outcome_reason carries which one.
  -- 'failed'    — we attempted the send and the platform call errored.
  outcome text not null
    check (outcome in ('sent', 'blocked', 'failed')),
  -- Machine-readable reason. For 'blocked': kill_switch | not_trusted |
  -- not_opted_in | rate_capped | channel_unsupported | already_replied.
  -- For 'failed': the truncated platform error. For 'sent': null.
  outcome_reason text,
  -- The exact text we sent (or would have sent). Capped to match the reply
  -- length ceiling used by the manual composer.
  reply_text text not null check (length(reply_text) between 1 and 3000),
  -- Platform-native id of the reply we created, when outcome='sent'.
  external_id text,
  -- The synthetic posts row created for audit parity (mirrors the manual
  -- send path). Soft pointer — no FK — same rationale as
  -- interactions.replied_to_post_id.
  reply_post_id uuid,
  created_at timestamptz not null default now()
);

-- Hot path: the rate-cap guard counts sent auto-replies for one account in
-- the trailing hour. Partial index on outcome='sent' keeps it tight, and the
-- (social_account_id, created_at) ordering covers the windowed count.
create index if not exists auto_reply_log_account_sent_idx
  on public.auto_reply_log (social_account_id, created_at desc)
  where outcome = 'sent';

-- Audit-browse path: the workspace's full auto-reply history, newest first.
create index if not exists auto_reply_log_workspace_created_idx
  on public.auto_reply_log (workspace_id, created_at desc);

alter table public.auto_reply_log enable row level security;

-- Mirror the interactions RLS style (migration 023): members read; writes go
-- through the service-role client in the cron, which bypasses RLS, but we keep
-- a member-scoped write policy for symmetry and to allow a future in-app
-- "send now" affordance.
create policy "Members can read auto_reply_log"
  on public.auto_reply_log for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write auto_reply_log"
  on public.auto_reply_log for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.auto_reply_log is
  'Bet 4: audit trail of every autonomous reply auto-sent (or blocked/failed). Also the source the per-account hourly rate cap counts against.';

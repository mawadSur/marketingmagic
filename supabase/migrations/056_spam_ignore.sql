-- marketingmagic · 056 — Inbox spam auto-ignore (TODO #0, gap 1)
--
-- Extends the reply inbox (migration 023) + the Bet 4 autonomous engagement
-- safety model (045/048) with an AUTO-IGNORE pass: on channels a workspace has
-- explicitly trusted, the poll-interactions cron can classify an inbound as
-- spam and move it out of the operator's default view (status='ignored')
-- instead of leaving junk in the inbox.
--
-- ─────────────────────────────────────────────────────────────
-- SAFETY POSTURE — auto-ignoring a row HIDES it from the operator's default
-- view. A false positive drops a real customer reply. So this mirrors the
-- Bet 4 auto-reply posture exactly:
--
--   * OFF by default. spam_ignore_mode defaults 'off'; the workspace must
--     consciously flip to 'shadow' (audit-only preview) and then 'live'.
--   * TRI-STATE off | shadow | live, reusing the EngagementMode model from
--     migration 048. 'shadow' classifies + audits what it WOULD ignore but
--     NEVER flips the row — zero blast radius, reachable without trust so the
--     operator can preview before earning the right to act.
--   * Trust-gated: a LIVE flip requires the existing publishing trust model
--     (social_accounts.trust_mode) AND the workspace mode='live'.
--   * Kill-switch reuse: the existing workspaces.auto_reply_kill_switch
--     silences spam-ignore too (one "stop everything" lever).
--   * Conservative classifier: only a confident 'spam' verdict is auto-
--     ignored; 'borderline' is surfaced for human review, never dropped.
--   * Fully audited in spam_ignore_log (verdict + signals + score), so
--     nothing is silently dropped — mirrors the auto_reply_log discipline.
--   * Channel set restricted to {x, bluesky, linkedin} (same as auto-reply;
--     IG/Threads inbound is read-only pending Meta App Review).
--
-- This migration adds NO new env vars and reuses the existing RLS helpers.
-- Migration number 056 chosen to avoid collision with sibling branches
-- 053/054/055.

-- ── 1. Per-interaction spam score ────────────────────────────────────────
-- 0-100, HIGHER = spammier (the inverse of priority_score). Computed by
-- src/lib/interactions/spam.ts and persisted on every classified row, even in
-- 'off' workspaces, so the inbox can sort/surface a "likely spam" lane without
-- the auto-ignore action being enabled. NULL until first classified.
alter table public.interactions
  add column if not exists spam_score numeric
    check (spam_score is null or (spam_score >= 0 and spam_score <= 100));

comment on column public.interactions.spam_score is
  'TODO #0 (056): 0-100 spam likelihood (higher = spammier). Set by src/lib/interactions/spam.ts on poll. NULL until first classified. Independent of priority_score.';

-- ── 2. New interaction lifecycle state: 'ignored' ────────────────────────
-- A LIVE spam-ignore flips an unread row to status='ignored'. Distinct from
-- 'dismissed' (a manual human clear) so the inbox can show an explicit
-- "auto-ignored as spam" review lane — nothing is silently lost.
alter table public.interactions
  drop constraint if exists interactions_status_check;
alter table public.interactions
  add constraint interactions_status_check
    check (status in ('unread', 'read', 'replied', 'snoozed', 'dismissed', 'ignored'));

-- ── 3. Per-workspace spam-ignore mode + Claude opt-in ────────────────────
-- Default 'off' — conservative by construction, identical posture to the
-- auto_reply_mode default in migration 048.
alter table public.workspaces
  add column if not exists spam_ignore_mode text not null default 'off'
    check (spam_ignore_mode in ('off', 'shadow', 'live'));

comment on column public.workspaces.spam_ignore_mode is
  'TODO #0 (056): tri-state inbox spam auto-ignore — off | shadow | live. Shadow classifies + audits what it WOULD ignore but NEVER flips a row. Live flips spam → status=ignored. Requires trust_mode to go live; respects auto_reply_kill_switch. Defaults off.';

-- Whether to escalate the borderline band to a Claude classify call. Default
-- false: heuristics only. Borderline rows are surfaced for human review when
-- this is off; when on, only a confident Claude 'spam' call upgrades them.
alter table public.workspaces
  add column if not exists spam_ignore_use_claude boolean not null default false;

comment on column public.workspaces.spam_ignore_use_claude is
  'TODO #0 (056): opt-in to escalate borderline-band inbound to a Claude spam classify (fail-open toward ham). Defaults false (cheap heuristics only).';

-- ── 4. Audit log ─────────────────────────────────────────────────────────
-- One row per spam-ignore DECISION (ignored / shadow / blocked), so the
-- operator can review every auto-ignore and every would-ignore. This is the
-- "nothing is silently dropped" surface — mirrors auto_reply_log.
create table if not exists public.spam_ignore_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  -- The inbound interaction we classified. ON DELETE SET NULL so purging an
  -- interaction never erases the audit trail of what we ignored.
  interaction_id uuid references public.interactions(id) on delete set null,
  channel text not null
    check (channel in ('x', 'bluesky', 'linkedin')),
  -- 'ignored'  — row was flipped to status='ignored' (live).
  -- 'shadow'   — would-ignore was audited; row left visible (shadow).
  -- 'blocked'  — a spam verdict was HELD by a guard (kill switch / not-trusted).
  outcome text not null
    check (outcome in ('ignored', 'shadow', 'blocked')),
  -- Machine-readable reason for 'blocked': kill_switch | not_trusted. Null for
  -- ignored/shadow.
  outcome_reason text,
  -- The 0-100 spam score that drove the decision.
  spam_score numeric not null check (spam_score >= 0 and spam_score <= 100),
  -- The verdict band the classifier landed on.
  verdict text not null check (verdict in ('ham', 'spam', 'borderline')),
  -- Compact, human-readable summary of the heuristic (+ optional Claude)
  -- signals that fired — the "why" for the review UI.
  signal_summary text not null check (length(signal_summary) between 1 and 1000),
  created_at timestamptz not null default now()
);

-- Audit-browse path: the workspace's full spam-ignore history, newest first.
create index if not exists spam_ignore_log_workspace_created_idx
  on public.spam_ignore_log (workspace_id, created_at desc);

alter table public.spam_ignore_log enable row level security;

-- Mirror the auto_reply_log RLS style (migration 045): members read; writes go
-- through the service-role client in the cron (bypasses RLS), but keep a
-- member-scoped write policy for symmetry.
create policy "Members can read spam_ignore_log"
  on public.spam_ignore_log for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write spam_ignore_log"
  on public.spam_ignore_log for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.spam_ignore_log is
  'TODO #0 (056): audit trail of every spam auto-ignore decision (ignored / shadow / blocked). Nothing is silently dropped — every auto-ignore + every would-ignore is reviewable here.';

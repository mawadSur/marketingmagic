-- marketingmagic · 047 — Weekly Autonomous Growth Orchestrator (Bet 5)
--
-- Bet 5 chains the four shipped bets into ONE self-driving weekly cycle and
-- emails the owner a "what I did and what I drove" digest. This migration adds
-- the two pieces of persistent state that cycle needs:
--
--   1. A per-WORKSPACE autopilot mode (default 'draft') — the trust dial.
--   2. A per-RUN idempotency record (weekly_growth_runs) so the cron never
--      double-sends inside the same weekly window.
--
-- ─────────────────────────────────────────────────────────────
-- TRUST POSTURE — DRAFT BY DEFAULT. This is the keystone safety decision of
-- Bet 5 and it lives here as a column default, not just app code:
--
--   * The weekly cycle PREPARES — it computes revenue-by-theme, the theme
--     winners, a summary of any auto-replies/DMs that already fired (Bet 4
--     runs in its OWN cron; we only SUMMARISE its logs, never re-trigger it),
--     and a recommended focus for next week. Then it emails the owner.
--   * It does NOT auto-publish, auto-replan, or auto-atomize. The owner reads
--     the digest and acts. autopilot_mode = 'draft' encodes exactly that.
--   * 'auto' is reserved for a LATER graduation (a workspace the owner has
--     explicitly promoted). The default is 'draft' so a workspace can never
--     silently start acting on its own. No new env vars; reuses CRON_SECRET.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Per-workspace autopilot mode ──────────────────────────────────────
-- 'draft' = prepare + email a recommendation, take no autonomous action
--           (today's behaviour, and the only behaviour the cron acts on).
-- 'auto'  = reserved for a future graduation where the owner has opted a
--           workspace into autonomous action. The cron treats anything other
--           than 'auto' as draft, so adding 'auto' later is purely additive.
-- Defaults 'draft': conservative by construction, mirrors the 045 kill-switch
-- "off by default" posture.
alter table public.workspaces
  add column if not exists autopilot_mode text not null default 'draft'
    check (autopilot_mode in ('draft', 'auto'));

comment on column public.workspaces.autopilot_mode is
  'Bet 5: weekly-growth-orchestrator trust dial. ''draft'' (default) = prepare + email a recommendation, NEVER act autonomously. ''auto'' = reserved future graduation. The cron only takes autonomous action when this is ''auto''.';

-- ── 2. Per-run idempotency record ────────────────────────────────────────
-- One row per workspace per weekly window. The cron stamps this BEFORE it
-- sends, so a second tick inside the same window sees the row and skips —
-- the digest email is never sent twice. The window is keyed by an ISO date
-- string for the Monday of the cycle week (computed in app code), so the
-- uniqueness guard is a plain (workspace_id, window_start) pair.
--
-- We also record what the cycle PRODUCED (counts + the chosen focus) so the
-- run history is auditable: an operator can answer "what did the orchestrator
-- recommend three weeks ago" without re-deriving it.
create table if not exists public.weekly_growth_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The Monday (UTC, ISO date) of the cycle week this run covers. The
  -- idempotency key — one run per workspace per week.
  window_start date not null,
  -- The mode the cycle ran in for this workspace at the time. Snapshotted so
  -- a later flip of workspaces.autopilot_mode doesn't rewrite history.
  mode text not null
    check (mode in ('draft', 'auto')),
  -- 'sent'    — digest email delivered.
  -- 'skipped' — cold-start (nothing to report) or no recipient; no email.
  -- 'failed'  — assembly or send errored. Recorded so a retry next tick can
  --             see it and (because the row exists) NOT double-send a partial.
  status text not null
    check (status in ('sent', 'skipped', 'failed')),
  -- What the cycle measured / recommended this week — a compact audit blob.
  -- { postsShipped, impressions, engagements, revenueCents, autoReplies,
  --   dmsSent, recommendedThemes: [] }. JSONB because it's a single small blob
  --   read as a unit, never queried by sub-field.
  summary jsonb,
  -- Why we skipped / failed, when status != 'sent'. NULL for 'sent'.
  detail text,
  created_at timestamptz not null default now()
);

-- The idempotency guard: at most one run per workspace per weekly window.
-- A second tick in the same window hits this unique index and the cron's
-- pre-check (a select on this pair) short-circuits before any send.
create unique index if not exists weekly_growth_runs_ws_window_idx
  on public.weekly_growth_runs (workspace_id, window_start);

-- Audit-browse path: a workspace's run history, newest first.
create index if not exists weekly_growth_runs_ws_created_idx
  on public.weekly_growth_runs (workspace_id, created_at desc);

alter table public.weekly_growth_runs enable row level security;

-- Mirror the post_outcomes / auto_reply_log RLS style (042 / 045): members of
-- the owning workspace read their own run history; writes go through the
-- service-role client in the cron (which bypasses RLS). We keep a member-scoped
-- write policy for symmetry and a future in-app "run now" affordance.
create policy "weekly_growth_runs: members read own workspace"
  on public.weekly_growth_runs for select
  using (public.is_workspace_member(workspace_id));

create policy "weekly_growth_runs: members write own workspace"
  on public.weekly_growth_runs for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.weekly_growth_runs is
  'Bet 5: one row per workspace per weekly window — the idempotency record for the weekly-growth-orchestrator cron (never double-send a window) plus an audit blob of what the cycle measured/recommended.';

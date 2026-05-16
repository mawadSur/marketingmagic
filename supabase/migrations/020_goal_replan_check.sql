-- marketingmagic · 020 — Goal replan check (Phase 2.1 follow-up)
--
-- Two adjacent additions for the mid-course replan trigger:
--
--   1. `content_goals.last_replan_check_at` — timestamptz, nullable. Stamped
--      by the daily cron at /api/cron/goal-replan-check every time it walks
--      a goal. We use the column to throttle: a goal won't generate a new
--      replan_proposal more than once per 7 days, even if it stays behind
--      pace. Nullable because pre-migration rows have never been checked.
--
--   2. `replan_proposals` — one row per "we noticed this goal is behind"
--      event. Created by the cron with `proposed_by='cron'` + the matching
--      `reason` (e.g. 'behind_at_week_2'). The dashboard widget reads
--      unaccepted proposals to surface a CTA on the goal card; clicking
--      the CTA stamps `accepted_at` and routes the user into the replan
--      flow (`/goals/[id]?replan=1`). The actual replan UX is a follow-up.
--
-- We deliberately don't auto-replan. Surfacing the proposal and letting
-- the user click "yes, regenerate" preserves the two-step approval gate
-- the rest of the goals flow uses (strategy approve → posts approve).

-- ─────────────────────────────────────────────────────────────
-- content_goals.last_replan_check_at
-- ─────────────────────────────────────────────────────────────
alter table public.content_goals
  add column if not exists last_replan_check_at timestamptz;

-- Partial index for the cron's "which goals are due to be checked again?"
-- scan. Only active goals are ever checked, and rows where the column is
-- null are always due — so the index covers the cron's hot path.
create index if not exists content_goals_replan_check_idx
  on public.content_goals(last_replan_check_at)
  where status = 'active';

-- ─────────────────────────────────────────────────────────────
-- replan_proposals
-- ─────────────────────────────────────────────────────────────
create table if not exists public.replan_proposals (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.content_goals(id) on delete cascade,
  -- When the proposal was raised. Set to now() on insert.
  proposed_at timestamptz not null default now(),
  -- Where the proposal came from. V1: 'cron' (the daily check) or 'user'
  -- (a future "I want to replan now" surface). Free-form text + CHECK so
  -- adding a third origin is a one-line migration.
  proposed_by text not null default 'cron' check (proposed_by in ('cron', 'user')),
  -- Short tag explaining why. Cron emits e.g. 'behind_at_week_2' so the
  -- dashboard widget can show the right copy without re-running the
  -- progress computation.
  reason text not null,
  -- When the user accepted the proposal. Nullable until they click through
  -- to /goals/[id]?replan=1 and confirm. Once stamped, the dashboard
  -- widget stops surfacing this proposal.
  accepted_at timestamptz,
  -- Optional FK to the auth user who accepted. Nullable for the same
  -- reason — most proposals will be unaccepted at any given time.
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Lookup pattern: "any unaccepted proposals for this goal?" — partial
-- index on accepted_at IS NULL keeps the widget query fast.
create index if not exists replan_proposals_open_idx
  on public.replan_proposals(goal_id, proposed_at desc)
  where accepted_at is null;

-- Cron throttle pattern: "did I already raise a proposal for this goal
-- in the last 7 days?" — proposed_at desc covers it.
create index if not exists replan_proposals_goal_idx
  on public.replan_proposals(goal_id, proposed_at desc);

alter table public.replan_proposals enable row level security;

-- Read: any workspace member of the goal's workspace. Resolved via the
-- goal's workspace_id rather than denormalizing — proposals are tiny and
-- the join is one hop.
create policy "Members can read replan_proposals"
  on public.replan_proposals for select
  using (exists (
    select 1 from public.content_goals g
    where g.id = goal_id and public.is_workspace_member(g.workspace_id)
  ));

-- Write (accept): any workspace member can update a proposal — they own
-- the goal. Insert is service-role only (the cron); members never insert
-- their own rows in V1.
create policy "Members can update replan_proposals"
  on public.replan_proposals for update
  using (exists (
    select 1 from public.content_goals g
    where g.id = goal_id and public.is_workspace_member(g.workspace_id)
  ))
  with check (exists (
    select 1 from public.content_goals g
    where g.id = goal_id and public.is_workspace_member(g.workspace_id)
  ));

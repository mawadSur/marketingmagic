-- marketingmagic · 018 — Reverse-Plan from a Content Goal (Phase 2.1)
--
-- Customer states a goal (followers / inbound / launch_date / credibility /
-- recovery / custom) + a timeline. We ask Claude to propose a *strategy* —
-- theme weights, posting cadence, milestone narrative — then a second pass
-- generates 4–12 weeks of posts reverse-engineered to hit it. Two approval
-- gates: strategy first, then the posts. Every post the goal spawns gets
-- `goal_id` stamped so dashboards can roll engagement up to the goal level.
--
-- Two schema concerns in this migration:
--
--   1. `content_goals` — the goal itself: free-form goal_text + a metric
--      discriminator + target_value/target_date. `strategy` jsonb caches the
--      structured strategy Claude returned so the user can re-open the
--      preview screen without burning another LLM call. `baseline_snapshot`
--      jsonb records the workspace's "before" state at goal-creation time
--      (follower counts, recent engagement) so the future dashboard widget
--      can frame progress honestly ("grew 312 vs baseline 89/month").
--
--   2. `posts.goal_id` — nullable FK pointing at the goal that produced
--      this post. NULL for posts not generated from a goal. Mirrors the
--      `posts.source_id` pattern from migration 009. ON DELETE SET NULL
--      preserves the audit trail of posts already shipped.
--
-- No new env vars. The reverse-planner reuses ANTHROPIC_API_KEY.

-- ─────────────────────────────────────────────────────────────
-- content_goals
-- ─────────────────────────────────────────────────────────────
create table if not exists public.content_goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Free-form description ("hit 5k followers by demo day", "land 3 inbound
  -- design partners"). The user-facing label; Claude reads this verbatim
  -- alongside the structured metric/target fields.
  goal_text text not null,
  -- Discriminator. `custom` is the catch-all so the questionnaire never
  -- forces the user into a wrong bucket. Adding a metric = update this
  -- CHECK + the Zod enum in src/lib/goals/schema.ts.
  goal_metric text not null check (goal_metric in (
    'followers',
    'inbound',
    'launch_date',
    'credibility',
    'recovery',
    'custom'
  )),
  -- Numeric target where it makes sense (5000 followers, 25 inbound DMs).
  -- Nullable for goal_metric='launch_date' / 'credibility' where the metric
  -- is a date or a qualitative state.
  target_value numeric,
  -- Calendar deadline. Strongly recommended (we use it to size the plan in
  -- weeks) but not required — credibility / recovery goals can be open-ended.
  target_date date,
  -- Goal lifecycle:
  --   draft     — strategy proposed, user has not committed yet
  --   active    — strategy approved AND posts generated; goal is being executed
  --   paused    — user pressed pause; cron skips, posts stay scheduled
  --   achieved  — closed out positively
  --   abandoned — closed out negatively (or the user gave up)
  -- Defaults to 'draft' because the /goals/new flow always creates the row
  -- on strategy-proposal *before* the user approves.
  status text not null default 'draft' check (status in (
    'draft',
    'active',
    'paused',
    'achieved',
    'abandoned'
  )),
  -- Workspace state captured at goal-creation time. Shape is intentionally
  -- loose (jsonb) because we'll grow it as the future dashboard widget
  -- needs more fields. V1 captures: follower counts per channel, rolling
  -- 30d engagement, recent post count. Nullable when we couldn't snapshot
  -- (cold-start workspace, missing analytics).
  baseline_snapshot jsonb,
  -- Structured strategy Claude returned (theme weights, posting cadence,
  -- milestone narrative, weeks count, success_criteria). Cached here so
  -- the strategy-preview page can re-open without re-calling the LLM. Also
  -- the source of truth that generatePostsFromGoal() reads from when the
  -- user approves. Shape mirrored by Zod in src/lib/goals/schema.ts.
  strategy jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_goals_workspace_idx
  on public.content_goals(workspace_id, created_at desc);

-- Partial index — dashboards / cron only care about non-terminal goals.
create index if not exists content_goals_active_idx
  on public.content_goals(workspace_id, status)
  where status in ('draft', 'active', 'paused');

-- Reuses the shared trigger function from migration 001.
create trigger content_goals_set_updated_at
  before update on public.content_goals
  for each row execute function public.set_updated_at();

alter table public.content_goals enable row level security;

-- Read: any workspace member. Goal text + strategy is inside-the-team data;
-- editors need it to understand "why was this post generated?".
create policy "Members can read content_goals"
  on public.content_goals for select
  using (public.is_workspace_member(workspace_id));

-- Write: any workspace member can create / edit / delete goals for their
-- workspace. Mirrors how sources and plans behave. Service role bypasses
-- RLS for the eventual replan cron.
create policy "Members can write content_goals"
  on public.content_goals for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- posts.goal_id (goal attribution)
-- ─────────────────────────────────────────────────────────────
-- Nullable + ON DELETE SET NULL so deleting a goal preserves the audit
-- trail of posts already published from it. Analytics rolls engagement up
-- via this FK; rows where goal_id IS NULL are simply excluded from
-- goal-attribution dashboards. Mirrors posts.source_id from migration 009.
alter table public.posts
  add column if not exists goal_id uuid references public.content_goals(id) on delete set null;

-- Partial index — the dashboard query only looks at non-null goal_id.
create index if not exists posts_goal_id_idx
  on public.posts(goal_id)
  where goal_id is not null;

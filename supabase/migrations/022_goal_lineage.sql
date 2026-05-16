-- marketingmagic · 022 — Goal lineage (Phase 2.1 replan UI loop)
--
-- When a user accepts a replan_proposal, we don't mutate the original goal
-- — we spawn a NEW content_goals row (draft + new strategy) and link it
-- back to the original via `parent_goal_id`. This preserves the audit
-- trail ("here's the original 'hit 5k followers in 4 weeks' goal that we
-- replanned mid-flight at week 3") and unlocks a future "Goal history"
-- page that renders the replan tree.
--
-- Design notes:
--
--   - `parent_goal_id` references content_goals(id). Nullable because
--     the vast majority of goals are roots (not replans). ON DELETE SET
--     NULL preserves the descendant if the parent is hard-deleted —
--     dropping the replanned-from goal shouldn't cascade-nuke the active
--     replan.
--
--   - Partial index on non-null values is the only access pattern we
--     care about. Two queries it covers:
--       1. "Does THIS goal have any descendants?" (for the dashboard
--          widget's 'Replanned' badge — see goal-progress-widget.tsx).
--       2. "Walk the ancestor chain from this goal back to the root"
--          (for the future Goal history page — see lib/goals/lineage.ts).
--     Both predicate on parent_goal_id IS NOT NULL.
--
-- RLS unchanged. The member-write policy from 018 already covers
-- content_goals across the board; adding a new column doesn't widen
-- access. The replan server action runs as the authed user, so RLS
-- naturally restricts the insert to the user's own workspace_id.

alter table public.content_goals
  add column if not exists parent_goal_id uuid
    references public.content_goals(id) on delete set null;

-- Partial index — every query that touches parent_goal_id filters on
-- IS NOT NULL. Tiny index, tiny win, but worth it because the "does
-- this goal have descendants?" check fires once per active goal on the
-- dashboard.
create index if not exists content_goals_parent_idx
  on public.content_goals(parent_goal_id)
  where parent_goal_id is not null;

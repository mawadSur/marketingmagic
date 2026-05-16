// Phase 2.1 follow-up — goal lineage primitives.
//
// When the user accepts a replan_proposal, the replan server action
// spawns a NEW content_goals row whose `parent_goal_id` points at the
// goal that was replanned-from. The chain can extend ("we replanned the
// replan"), so the lineage is technically a singly-linked list — there
// is one parent per goal, but a parent can have multiple replan
// descendants if the user accepts several proposals over time.
//
// getGoalLineage(goalId) walks the parent chain back to the root and
// returns the ancestors in order (closest-parent first → root last). A
// future "Goal history" page will render this as a timeline; for V1 the
// data primitive ships alone so the migration can land without UI churn.
//
// Hard caps:
//   - MAX_DEPTH = 16 — the chain can never legitimately go that deep.
//     Defends against cycles introduced by bad DB writes (the DB schema
//     doesn't prevent A→B→A loops since both rows can be inserted
//     independently). When we hit the cap we return what we have and
//     log a warning — never throw, because a future UI rendering this
//     data should fail-soft.
//
// The function is read-only and uses the service-role client (RLS would
// require workspace context the future Goal history page may not have
// in scope at call time). Callers MUST gate access by workspace
// membership themselves before exposing lineage data to a user.

import { supabaseService } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/types";

type ContentGoalRow = Database["public"]["Tables"]["content_goals"]["Row"];

const MAX_DEPTH = 16;

export interface GoalLineage {
  // The starting goal (the one whose ancestry the caller asked about).
  // Null when the goal_id isn't found — separating this from an empty
  // ancestor list lets callers distinguish "root goal" from "missing".
  goal: ContentGoalRow | null;
  // Ancestor chain. ancestors[0] is the immediate parent, ancestors[N]
  // is the root. Empty when the starting goal IS a root (no parent).
  ancestors: ContentGoalRow[];
  // True when we stopped walking due to MAX_DEPTH. The future UI can
  // surface "lineage truncated" rather than silently lying about the
  // chain length.
  truncated: boolean;
}

export async function getGoalLineage(goalId: string): Promise<GoalLineage> {
  const svc = supabaseService();

  const { data: startRow } = await svc
    .from("content_goals")
    .select("*")
    .eq("id", goalId)
    .maybeSingle();
  if (!startRow) {
    return { goal: null, ancestors: [], truncated: false };
  }
  const start = startRow as ContentGoalRow;

  const ancestors: ContentGoalRow[] = [];
  const visited = new Set<string>([start.id]);

  let cursor: ContentGoalRow = start;
  let truncated = false;

  for (let i = 0; i < MAX_DEPTH; i++) {
    const parentId = cursor.parent_goal_id;
    if (!parentId) break;

    // Cycle guard. Should never fire in practice but cheap to check.
    if (visited.has(parentId)) {
      console.warn("getGoalLineage: cycle detected at goal", parentId);
      break;
    }
    visited.add(parentId);

    const { data: parentRow } = await svc
      .from("content_goals")
      .select("*")
      .eq("id", parentId)
      .maybeSingle();
    if (!parentRow) break;

    const parent = parentRow as ContentGoalRow;
    ancestors.push(parent);
    cursor = parent;

    if (i === MAX_DEPTH - 1 && parent.parent_goal_id != null) {
      truncated = true;
    }
  }

  return { goal: start, ancestors, truncated };
}

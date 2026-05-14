// Workspace switcher palette stats — a stripped-down peer to
// `src/lib/portfolio/queries.ts`. Returns just the per-workspace
// posts-shipped count in the last 7 days, fetched in a single batched
// query rather than fan-out so the cmd-K palette renders fast even
// when the user has dozens of workspaces.
//
// Used by `src/app/(app)/layout.tsx`. Service-role bypass because the
// caller has already filtered to workspaces the user belongs to via
// `listWorkspaces()` (RLS-gated through the standard server client).

import { supabaseService } from "@/lib/supabase/service";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return a Map of workspace_id → posts shipped in the last 7 days.
 * Workspaces with zero shipped posts are omitted from the map.
 *
 * Strategy: one query pulling just `workspace_id` for posts with
 * `status = 'posted' AND posted_at >= now-7d`, scoped to the input id
 * set. Cheap because posts is indexed on `(workspace_id, status)`.
 */
export async function getPostsShipped7dByWorkspace(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (workspaceIds.length === 0) return result;

  const svc = supabaseService();
  const since7 = new Date(Date.now() - WEEK_MS).toISOString();

  const { data } = await svc
    .from("posts")
    .select("workspace_id")
    .in("workspace_id", workspaceIds)
    .eq("status", "posted")
    .gte("posted_at", since7);

  for (const row of data ?? []) {
    result.set(row.workspace_id, (result.get(row.workspace_id) ?? 0) + 1);
  }
  return result;
}

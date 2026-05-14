import { supabaseService } from "@/lib/supabase/service";

// Load recent playbook patterns for plan-generator integration. We surface
// these in the planner's system prompt as "preferred patterns the user has
// explicitly saved from past winners." 90-day window keeps stale
// preferences from haunting the plan after the user's audience shifts.

const LOOKBACK_DAYS = 90;
const MAX_PATTERNS = 12;

export interface SavedPattern {
  pattern_kind: string;
  summary: string;
  saved_at: string;
}

export async function loadRecentPatterns(workspaceId: string): Promise<SavedPattern[]> {
  const svc = supabaseService();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await svc
    .from("playbook_patterns")
    .select("pattern_kind, summary, saved_at")
    .eq("workspace_id", workspaceId)
    .gte("saved_at", since)
    .order("saved_at", { ascending: false })
    .limit(MAX_PATTERNS);

  return (data ?? []) as SavedPattern[];
}

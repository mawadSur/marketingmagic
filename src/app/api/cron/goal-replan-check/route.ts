import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { checkGoalsForReplan } from "@/lib/goals/replan-check";

// Phase 2.1 follow-up — daily goal-replan check cron.
//
// Triggered by .github/workflows/cron-goal-replan-check.yml at 12:00 UTC.
// For every workspace that has at least one active goal:
//
//   1. Run checkGoalsForReplan(workspaceId) — returns goals that are
//      behind pace AND past week-2 AND haven't been proposed-against
//      in the last 7 days.
//   2. For each candidate, insert a `replan_proposals` row with
//      proposed_by='cron' + reason='behind_at_week_N'. The dashboard
//      widget reads unaccepted proposals and surfaces a CTA on the goal
//      card; clicking it stamps accepted_at and routes the user into
//      the replan flow.
//   3. Stamp `content_goals.last_replan_check_at = now()` so the next
//      cron tick can see we've already walked this goal.
//
// We deliberately don't auto-replan — surfacing the proposal preserves
// the two-step approval gate the rest of the goals flow uses (strategy
// approve → posts approve). The actual replan UX is a thin follow-up.
//
// Auth: Bearer CRON_SECRET (matches the other cron routes).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WORKSPACES_PER_RUN = 200;

interface PerWorkspaceResult {
  workspaceId: string;
  status: "proposed" | "clean" | "failed";
  proposedGoals?: number;
  goalIds?: string[];
  reason?: string;
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const svc = supabaseService();
  // Pull every workspace_id with at least one active goal. Distinct via
  // a small map — PostgREST doesn't expose DISTINCT directly but the
  // payload is bounded and we cap anyway.
  const { data: activeGoals, error: scanErr } = await svc
    .from("content_goals")
    .select("workspace_id")
    .eq("status", "active")
    .limit(2000);
  if (scanErr) {
    return NextResponse.json({ error: scanErr.message }, { status: 500 });
  }

  const workspaceIds = Array.from(
    new Set((activeGoals ?? []).map((r) => r.workspace_id as string)),
  ).slice(0, MAX_WORKSPACES_PER_RUN);

  const results: PerWorkspaceResult[] = [];

  for (const workspaceId of workspaceIds) {
    try {
      const candidates = await checkGoalsForReplan(workspaceId);
      const goalIds: string[] = [];

      for (const c of candidates) {
        // Insert the proposal. We don't dedupe at insert time — the
        // 7-day throttle inside checkGoalsForReplan already guards
        // against duplicate-per-week. RLS bypass is automatic on the
        // service-role client.
        const { error: insErr } = await svc.from("replan_proposals").insert({
          goal_id: c.progress.goal.id,
          proposed_by: "cron",
          reason: c.reason,
        });
        if (insErr) {
          // Log + continue — one failed insert shouldn't kill the run.
          console.error(
            `[goal-replan-check] insert failed for goal ${c.progress.goal.id}:`,
            insErr.message,
          );
          continue;
        }
        goalIds.push(c.progress.goal.id);
      }

      // Stamp every active goal we walked — both the proposed-against
      // ones AND the clean ones — so the throttle is uniform.
      const { data: walkedGoals } = await svc
        .from("content_goals")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("status", "active");
      const walkedIds = (walkedGoals ?? []).map((g) => g.id as string);
      if (walkedIds.length > 0) {
        await svc
          .from("content_goals")
          .update({ last_replan_check_at: new Date().toISOString() })
          .in("id", walkedIds);
      }

      results.push({
        workspaceId,
        status: goalIds.length > 0 ? "proposed" : "clean",
        proposedGoals: goalIds.length,
        goalIds,
      });
    } catch (err) {
      // Capture the error to Sentry so silently-broken crons are visible. Graceful
      // no-op when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "goal-replan-check", workspace_id: workspaceId },
      });
      results.push({
        workspaceId,
        status: "failed",
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    checked: results.length,
    proposed: results.filter((r) => r.status === "proposed").length,
    clean: results.filter((r) => r.status === "clean").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
    at: new Date().toISOString(),
  });
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { findNeglectedThemes, type NeglectedTheme } from "@/lib/themes/gaps";

// Phase 6.9 — daily theme-gap detection cron.
//
// Triggered by .github/workflows/cron-theme-gaps.yml at 13:30 UTC (30
// minutes ahead of the email-digest run so its work is observable but the
// digest still reads live data on each cron run too — we deliberately
// don't cache results here). Auth: Bearer CRON_SECRET (matches the other
// cron routes).
//
// This route is observability-only: it returns per-workspace summaries so
// the GH Actions log captures "who has gaps this morning". No DB mutation
// is performed — the dashboard widget and the email-digest cron each call
// findNeglectedThemes() at read time. Keeping the cron stateless avoids
// a stale cache + a new table just to memoize a fast aggregation.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WORKSPACES_PER_RUN = 200;

interface PerWorkspaceResult {
  workspaceId: string;
  status: "neglected" | "clean" | "skipped" | "failed";
  neglectedCount?: number;
  topTheme?: string;
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
  // We iterate every workspace that has a brief — gap detection short-
  // circuits inside findNeglectedThemes() when theme_gaps_enabled is off,
  // but we still need to enumerate to spot workspaces with opted-in gaps.
  const { data: briefs, error: briefsErr } = await svc
    .from("brand_briefs")
    .select("workspace_id, theme_gaps_enabled")
    .limit(MAX_WORKSPACES_PER_RUN);
  if (briefsErr) {
    return NextResponse.json({ error: briefsErr.message }, { status: 500 });
  }

  const results: PerWorkspaceResult[] = [];
  for (const brief of briefs ?? []) {
    const row = brief as { workspace_id: string; theme_gaps_enabled: boolean | null };
    if (row.theme_gaps_enabled === false) {
      results.push({
        workspaceId: row.workspace_id,
        status: "skipped",
        reason: "theme_gaps_enabled=false",
      });
      continue;
    }
    try {
      const neglected = await findNeglectedThemes(row.workspace_id);
      results.push(summarise(row.workspace_id, neglected));
    } catch (err) {
      // Capture the error to Sentry so silently-broken crons are visible. Graceful
      // no-op when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "theme-gaps", workspace_id: row.workspace_id },
      });
      results.push({
        workspaceId: row.workspace_id,
        status: "failed",
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    checked: results.length,
    flagged: results.filter((r) => r.status === "neglected").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
    at: new Date().toISOString(),
  });
}

function summarise(workspaceId: string, neglected: NeglectedTheme[]): PerWorkspaceResult {
  if (neglected.length === 0) {
    return { workspaceId, status: "clean" };
  }
  return {
    workspaceId,
    status: "neglected",
    neglectedCount: neglected.length,
    topTheme: neglected[0]?.theme,
  };
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

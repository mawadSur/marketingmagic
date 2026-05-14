// Phase 6.10 — one-shot historical hashtag backfill.
//
// Walks every workspace and scans its posts.text for hashtags, populating
// hashtag_usage. Idempotent via the unique (post_id, tag) constraint in
// migration 014 — running it a second time is a no-op.
//
// Auth: Bearer CRON_SECRET, same posture as the other cron + admin
// endpoints. The route is intentionally rare-use (one-time on first
// deploy; re-runnable for safety). Per-workspace bounding keeps a single
// invocation well under any timeout.
//
// Usage:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//        "https://<host>/api/admin/backfill-hashtags?limit=2000"

import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { backfillHashtagsForWorkspace } from "@/lib/hashtags/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT_PER_WORKSPACE = 2000;
const MAX_WORKSPACES_PER_RUN = 200;

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

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(10_000, Number(limitParam))) : DEFAULT_LIMIT_PER_WORKSPACE;
  const workspaceFilter = req.nextUrl.searchParams.get("workspace_id");

  const svc = supabaseService();
  let workspaceIds: string[] = [];
  if (workspaceFilter) {
    workspaceIds = [workspaceFilter];
  } else {
    const { data, error } = await svc
      .from("workspaces")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(MAX_WORKSPACES_PER_RUN);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    workspaceIds = (data ?? []).map((w) => w.id);
  }

  const results: Array<{
    workspace_id: string;
    scanned: number;
    with_tags: number;
    inserted: number;
    error?: string;
  }> = [];

  for (const wsId of workspaceIds) {
    try {
      const r = await backfillHashtagsForWorkspace(wsId, limit);
      results.push({
        workspace_id: wsId,
        scanned: r.scanned,
        with_tags: r.with_tags,
        inserted: r.inserted,
      });
    } catch (err) {
      results.push({
        workspace_id: wsId,
        scanned: 0,
        with_tags: 0,
        inserted: 0,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      with_tags: acc.with_tags + r.with_tags,
      inserted: acc.inserted + r.inserted,
      failed: acc.failed + (r.error ? 1 : 0),
    }),
    { scanned: 0, with_tags: 0, inserted: 0, failed: 0 },
  );

  return NextResponse.json({
    workspaces: results.length,
    totals,
    results,
  });
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

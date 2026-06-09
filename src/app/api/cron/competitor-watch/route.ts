import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { fetchCompetitorPosts } from "@/lib/competitors/fetch";
import {
  flagOutliers,
  computeEngagementRate,
  WINNER_LOOKBACK_DAYS,
} from "@/lib/competitors/detect-outliers";
import { extractCompetitorPattern } from "@/lib/competitors/extract-pattern";
import { isCompetitorWatchEnabled, GLOBAL_RATE_CAP_PER_15MIN } from "@/lib/billing/feature-gates";
import {
  buildAndDispatchWeeklyDigest,
  type CompetitorDigestResult,
} from "@/lib/competitors/digest";
import type { Database } from "@/lib/db/types";

// Phase 6.6 — daily competitor-watch cron.
//
// Triggered by .github/workflows/cron-competitor-watch.yml at 12:00 UTC
// daily. Auth: Bearer CRON_SECRET (same shape as the other cron routes).
//
// Pipeline per active watch handle (Founder/Agency tier workspaces only):
//   1. fetchCompetitorPosts → FetchedCompetitorPost[]
//   2. Upsert into competitor_posts (skip duplicates via unique
//      watch_handle_id × external_id).
//   3. Re-run flagOutliers over the trailing WINNER_LOOKBACK_DAYS window
//      for this handle; update is_winner.
//   4. For newly-flagged winners only, call extractCompetitorPattern and
//      cache the result on the row. We never re-extract.
//
// Rate budgeting: per-channel global cap (GLOBAL_RATE_CAP_PER_15MIN).
// We process handles in (last_pulled_at asc) order so oldest gets priority
// when we hit the cap. Hitting the cap → return early, the next cron run
// picks up the rest.
//
// Anti-harassment: extractCompetitorPattern has a refusal-trained system
// prompt; this route never passes "draft a response" or any adversarial
// framing into Claude (it only passes the post text + 'classify by structure').

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HANDLES_PER_RUN_HARD_CAP = 500;
const DAILY_POSTS_PER_HANDLE = 30;
const BACKFILL_POSTS_PER_HANDLE = 100;

type WatchHandleRow = Database["public"]["Tables"]["watch_handles"]["Row"];
type CompetitorPostRow = Database["public"]["Tables"]["competitor_posts"]["Row"];

interface PerHandleResult {
  watchHandleId: string;
  channel: string;
  handle: string;
  status: "pulled" | "rate_limited" | "failed" | "skipped" | "tier_gated";
  fetched?: number;
  inserted?: number;
  winners?: number;
  patternsExtracted?: number;
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

  // Pull all active handles ordered by oldest pull first. Per-channel
  // global counters are tracked across the loop so we honour the rate cap.
  const { data: rows, error } = await svc
    .from("watch_handles")
    .select("*")
    .in("status", ["active", "rate_limited", "failed"])
    .order("last_pulled_at", { ascending: true, nullsFirst: true })
    .limit(HANDLES_PER_RUN_HARD_CAP);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allHandles = (rows ?? []) as WatchHandleRow[];

  // Pre-resolve workspace plan for every handle to short-circuit any rows
  // belonging to non-tier workspaces (e.g. the workspace downgraded after
  // adding watch rows). We don't auto-delete — UI can show a "re-upgrade
  // to resume" prompt.
  const workspaceIds = Array.from(new Set(allHandles.map((h) => h.workspace_id)));
  const planByWs = new Map<string, string>();
  if (workspaceIds.length > 0) {
    const { data: wsRows } = await svc
      .from("workspaces")
      .select("id, plan")
      .in("id", workspaceIds);
    for (const ws of wsRows ?? []) {
      planByWs.set(ws.id, ws.plan);
    }
  }

  // Per-channel call budget (global). When a channel hits its cap we stop
  // processing more handles for that channel and continue with others.
  const channelBudget = { ...GLOBAL_RATE_CAP_PER_15MIN } as Record<string, number>;
  const rateLimitHits: Array<{ channel: string; watchHandleId: string }> = [];

  const results: PerHandleResult[] = [];
  for (const row of allHandles) {
    const plan = planByWs.get(row.workspace_id);
    if (!isCompetitorWatchEnabled(plan)) {
      results.push({
        watchHandleId: row.id,
        channel: row.channel,
        handle: row.handle,
        status: "tier_gated",
        reason: `plan=${plan ?? "unknown"}`,
      });
      continue;
    }
    const remaining = channelBudget[row.channel] ?? 0;
    if (remaining <= 0) {
      // Don't even attempt — observability marker so the dashboard knows
      // the cap was the reason, not a real API failure.
      rateLimitHits.push({ channel: row.channel, watchHandleId: row.id });
      results.push({
        watchHandleId: row.id,
        channel: row.channel,
        handle: row.handle,
        status: "rate_limited",
        reason: "channel_budget_exhausted",
      });
      continue;
    }
    channelBudget[row.channel] = remaining - 1;

    const result = await processHandle(row);
    results.push(result);
    if (result.status === "rate_limited") {
      rateLimitHits.push({ channel: row.channel, watchHandleId: row.id });
    }
  }

  // ── Weekly digest dispatch ───────────────────────────────────────
  // Run only on Sundays (UTC) or when the caller passes ?digest=force.
  // Per-workspace; one email + one Discord embed per workspace per week.
  // We fan out AFTER pulls so the digest reflects today's freshest data.
  const now = new Date();
  const digestRequested =
    req.nextUrl.searchParams.get("digest") === "force" || now.getUTCDay() === 0; // Sunday
  const digestResults: CompetitorDigestResult[] = [];
  if (digestRequested) {
    // Only include workspaces that have at least one tier-eligible handle.
    const eligibleWorkspaceIds = Array.from(
      new Set(
        allHandles
          .filter((h) => isCompetitorWatchEnabled(planByWs.get(h.workspace_id)))
          .map((h) => h.workspace_id),
      ),
    );
    if (eligibleWorkspaceIds.length > 0) {
      const { data: wsRows } = await svc
        .from("workspaces")
        .select("id, name, owner_id")
        .in("id", eligibleWorkspaceIds);
      for (const ws of wsRows ?? []) {
        let ownerEmail: string | null = null;
        try {
          const { data: userResp } = await svc.auth.admin.getUserById(ws.owner_id);
          ownerEmail = userResp?.user?.email ?? null;
        } catch {
          ownerEmail = null;
        }
        try {
          const dispatched = await buildAndDispatchWeeklyDigest(ws.id, ws.name, ownerEmail);
          digestResults.push(dispatched);
        } catch (err) {
          // Capture the error to Sentry so silently-broken crons are visible. Graceful
          // no-op when SENTRY_DSN is unset.
          Sentry.captureException(err, {
            tags: { cron: "competitor-watch", workspace_id: ws.id },
          });
          digestResults.push({
            workspaceId: ws.id,
            status: "failed",
            winnersIncluded: 0,
            emailReason: err instanceof Error ? err.message : "unknown",
          });
        }
      }
    }
  }

  return NextResponse.json({
    checked: allHandles.length,
    pulled: results.filter((r) => r.status === "pulled").length,
    rateLimited: results.filter((r) => r.status === "rate_limited").length,
    failed: results.filter((r) => r.status === "failed").length,
    tierGated: results.filter((r) => r.status === "tier_gated").length,
    rateLimitHits, // observability surface for the rate-limit dashboard widget
    digestDispatched: digestResults.length,
    digestResults,
    results,
    at: new Date().toISOString(),
  });
}

async function processHandle(row: WatchHandleRow): Promise<PerHandleResult> {
  const svc = supabaseService();

  // Initial backfill = pull more on first run. After the first successful
  // pull we settle into the daily cadence.
  const isFirstPull = row.last_pulled_at == null;
  const count = isFirstPull ? BACKFILL_POSTS_PER_HANDLE : DAILY_POSTS_PER_HANDLE;

  const outcome = await fetchCompetitorPosts({ handle: row, count });
  if (outcome.status === "rate_limited") {
    await markStatus(row.id, "rate_limited", outcome.reason);
    return {
      watchHandleId: row.id,
      channel: row.channel,
      handle: row.handle,
      status: "rate_limited",
      reason: outcome.reason,
    };
  }
  if (outcome.status === "failed") {
    await markStatus(row.id, "failed", outcome.reason);
    return {
      watchHandleId: row.id,
      channel: row.channel,
      handle: row.handle,
      status: "failed",
      reason: outcome.reason,
    };
  }

  // Insert with conflict-do-nothing — re-runs are idempotent.
  let inserted = 0;
  if (outcome.posts.length > 0) {
    const rows = outcome.posts.map((p) => ({
      watch_handle_id: row.id,
      workspace_id: row.workspace_id,
      external_id: p.external_id,
      post_url: p.post_url,
      posted_at: p.posted_at,
      text: p.text,
      likes: p.likes,
      reposts: p.reposts,
      replies: p.replies,
      impressions: p.impressions,
      engagement_rate: computeEngagementRate(p),
    }));
    const { data: insRows, error: insErr } = await svc
      .from("competitor_posts")
      .upsert(rows, { onConflict: "watch_handle_id,external_id", ignoreDuplicates: true })
      .select("id");
    if (insErr) {
      await markStatus(row.id, "failed", `insert_failed: ${insErr.message}`);
      return {
        watchHandleId: row.id,
        channel: row.channel,
        handle: row.handle,
        status: "failed",
        reason: insErr.message,
      };
    }
    inserted = insRows?.length ?? 0;
  }

  // Re-flag winners over the trailing window for THIS handle only. We
  // pull the full window because the percentile can shift when new posts
  // arrive.
  const since = new Date(
    Date.now() - WINNER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: windowPosts } = await svc
    .from("competitor_posts")
    .select("*")
    .eq("watch_handle_id", row.id)
    .gte("posted_at", since);

  const flags = flagOutliers((windowPosts ?? []) as CompetitorPostRow[]);
  const winnerIds = flags.filter((f) => f.is_winner).map((f) => f.postId);
  const loserIds = flags.filter((f) => !f.is_winner).map((f) => f.postId);

  if (winnerIds.length > 0) {
    await svc.from("competitor_posts").update({ is_winner: true }).in("id", winnerIds);
  }
  if (loserIds.length > 0) {
    await svc.from("competitor_posts").update({ is_winner: false }).in("id", loserIds);
  }

  // Pattern extraction — only for winners that haven't been extracted yet.
  // This keeps Claude tokens bounded; we never re-classify a post.
  let patternsExtracted = 0;
  if (winnerIds.length > 0) {
    const { data: needsExtraction } = await svc
      .from("competitor_posts")
      .select("id, text, pattern_tags")
      .in("id", winnerIds)
      .is("pattern_tags", null);
    for (const post of needsExtraction ?? []) {
      try {
        const result = await extractCompetitorPattern(post.text ?? "");
        await svc
          .from("competitor_posts")
          .update({
            pattern_tags: result.pattern.tags,
            pattern_reason: result.pattern.reason,
          })
          .eq("id", post.id);
        patternsExtracted += 1;
      } catch (err) {
        // Single extraction failure isn't fatal; log and continue.
        console.warn(
          `[competitor-watch] pattern extraction failed for ${post.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  await markStatus(row.id, "active", null);

  return {
    watchHandleId: row.id,
    channel: row.channel,
    handle: row.handle,
    status: "pulled",
    fetched: outcome.posts.length,
    inserted,
    winners: winnerIds.length,
    patternsExtracted,
  };
}

async function markStatus(
  watchHandleId: string,
  status: "active" | "failed" | "rate_limited",
  reason: string | null,
) {
  const svc = supabaseService();
  await svc
    .from("watch_handles")
    .update({
      status,
      failure_reason: reason,
      last_pulled_at: status === "active" ? new Date().toISOString() : undefined,
    })
    .eq("id", watchHandleId);
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  assembleWeeklyDigest,
  cycleWindowStart,
  generateWeeklyNarrative,
  type AssembledDigest,
} from "@/lib/growth/weekly-digest";
import { renderWeeklyGrowthDigest } from "@/lib/growth/weekly-digest-html";

// Weekly Autonomous Growth Orchestrator (Bet 5).
//
// ONE self-driving weekly cycle that chains the four shipped bets. Per ACTIVE
// workspace it:
//   1. Pulls last week's revenue-by-theme + theme winners (Bet 1) + posts
//      shipped / reach / engagement, and SUMMARISES the auto-replies/DMs that
//      already fired (Bet 4 audit logs — it never re-triggers that cron).
//   2. Produces a "weekly growth digest" email: what shipped, what it drove
//      ($/outcomes by theme), community autopilot activity, and a recommended
//      focus for next week.
//   3. DRAFT BY DEFAULT — workspaces.autopilot_mode (migration 047) gates
//      whether the cycle may act autonomously. Default 'draft': the cycle only
//      PREPARES + emails a recommendation; it does NOT publish, replan, or
//      atomize. 'auto' is reserved for a future graduation. We never act
//      autonomously here regardless — that lever is wired but intentionally
//      a no-op in this slice; the email tells the owner what's recommended.
//
// 429 MITIGATION: workspaces are processed SEQUENTIALLY (not a parallel fan-
// out), and each makes AT MOST ONE Claude call (generateWeeklyNarrative —
// streamed, maxRetries:6, max_tokens stop_reason guard). The narrative is
// optional: a model failure falls back to a deterministic summary, so the
// cycle never blocks on the model.
//
// IDEMPOTENCY: weekly_growth_runs has a unique (workspace_id, window_start)
// index keyed to the Monday of the cycle week. We pre-check it AND stamp it,
// so a second tick in the same window short-circuits — the digest is never
// double-sent.
//
// Auth: Bearer CRON_SECRET (EXACT same shape as the sibling crons). Triggered
// weekly from .github/workflows/cron-weekly-growth.yml. Graceful email
// degrade: RESEND_API_KEY / EMAIL_FROM unset → log + 200 (job stays green).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_URL = "https://api.resend.com/emails";
// Bound the per-run workspace count — same defensive cap the goal-replan cron uses.
const MAX_WORKSPACES_PER_RUN = 500;

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (env.CRON_SECRET && header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return Boolean(env.CRON_SECRET) && qs === env.CRON_SECRET;
}

interface PerWorkspaceResult {
  workspaceId: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = serverEnv();
  const emailConfigured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  if (!emailConfigured) {
    // Graceful degrade — log + skip all sends, 200 so the cron job is green.
    console.warn(
      "[weekly-growth] RESEND_API_KEY / EMAIL_FROM unset — skipping all sends.",
    );
    return NextResponse.json(
      { error: "email transport not configured (need RESEND_API_KEY + EMAIL_FROM)" },
      { status: 200 },
    );
  }

  const base = siteUrl();
  const svc = supabaseService();
  const now = new Date();
  const windowStart = cycleWindowStart(now);

  // All workspaces + their autopilot mode. Owner-only delivery mirrors the
  // engagement-report / learning-digest crons.
  const { data: wsRows, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id, autopilot_mode")
    .limit(MAX_WORKSPACES_PER_RUN);
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const results: PerWorkspaceResult[] = [];

  // SEQUENTIAL — one workspace at a time. Bounds peak concurrent Claude calls
  // to one, the core 429 mitigation. (A small-batch fan-out would be a future
  // optimization, but sequential is the safe default for a weekly cron.)
  for (const ws of wsRows ?? []) {
    const mode: "draft" | "auto" = ws.autopilot_mode === "auto" ? "auto" : "draft";

    // IDEMPOTENCY pre-check: already ran this window? Skip without re-sending.
    const { data: existing } = await svc
      .from("weekly_growth_runs")
      .select("id, status")
      .eq("workspace_id", ws.id)
      .eq("window_start", windowStart)
      .maybeSingle();
    if (existing) {
      skipped += 1;
      results.push({ workspaceId: ws.id, status: "skipped", reason: "already_ran_this_window" });
      continue;
    }

    let outcome: PerWorkspaceResult;
    try {
      outcome = await runWorkspace(ws.id, ws.name, ws.owner_id, mode, base, now, windowStart);
    } catch (err) {
      outcome = {
        workspaceId: ws.id,
        status: "failed",
        reason: err instanceof Error ? err.message : "cycle failed",
      };
      // Record the failure so a retry next tick sees the row and won't
      // double-send a partial. Best-effort — a record miss never throws.
      await recordRun(ws.id, windowStart, mode, "failed", null, outcome.reason ?? null);
    }

    if (outcome.status === "sent") sent += 1;
    else if (outcome.status === "skipped") skipped += 1;
    else failed += 1;
    results.push(outcome);
  }

  return NextResponse.json({
    checked: (wsRows ?? []).length,
    sent,
    skipped,
    failed,
    windowStart,
    results,
    at: now.toISOString(),
  });
}

// Run one workspace's cycle: assemble → (one) narrate → render → send → record.
async function runWorkspace(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  mode: "draft" | "auto",
  base: string,
  now: Date,
  windowStart: string,
): Promise<PerWorkspaceResult> {
  const svc = supabaseService();

  const assembled = await assembleWeeklyDigest(workspaceId, {
    workspaceName,
    mode,
    dashboardUrl: `${base}/dashboard`,
    analyticsUrl: `${base}/analytics`,
    now,
  });

  // COLD START — nothing to report. Record the skip (so we don't re-evaluate
  // this window) and move on.
  if (!assembled) {
    await recordRun(workspaceId, windowStart, mode, "skipped", null, "cold_start_no_activity");
    return { workspaceId, status: "skipped", reason: "cold_start_no_activity" };
  }

  // Resolve the owner's email.
  const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ownerId);
  const recipient = userResp?.user?.email;
  if (userErr || !recipient) {
    await recordRun(workspaceId, windowStart, mode, "skipped", summaryBlob(assembled), "owner_has_no_email");
    return { workspaceId, status: "skipped", reason: userErr?.message ?? "owner has no email" };
  }

  // The ONE Claude call (or deterministic fallback). Never throws.
  const narrative = await generateWeeklyNarrative(assembled);
  const html = renderWeeklyGrowthDigest({ ...assembled, narrative });

  const env = serverEnv();
  const resp = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: recipient,
      subject: `Your weekly growth recap — ${workspaceName}`,
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const reason = `resend ${resp.status}: ${errText.slice(0, 200)}`;
    await recordRun(workspaceId, windowStart, mode, "failed", summaryBlob(assembled), reason);
    return { workspaceId, status: "failed", reason };
  }

  await recordRun(workspaceId, windowStart, mode, "sent", summaryBlob(assembled), null);
  return { workspaceId, status: "sent" };
}

// Compact audit blob persisted alongside the run — what the cycle measured.
function summaryBlob(d: AssembledDigest) {
  return {
    postsShipped: d.shipped.posts,
    impressions: d.shipped.impressions,
    engagements: d.shipped.engagements,
    revenueCents: d.revenueCents,
    autoRepliesSent: d.community.autoRepliesSent,
    dmsSent: d.community.dmsSent,
    leadsTagged: d.community.leadsTagged,
    recommendedThemes: d.recommendedThemes,
  };
}

// Stamp the idempotency / audit record. Best-effort: a write miss is logged but
// never throws (the email already went out; we don't want to fail the run on a
// record hiccup). The unique (workspace_id, window_start) index also guards a
// race — a concurrent tick's insert is rejected, which is the desired outcome.
async function recordRun(
  workspaceId: string,
  windowStart: string,
  mode: "draft" | "auto",
  status: "sent" | "skipped" | "failed",
  summary: ReturnType<typeof summaryBlob> | null,
  detail: string | null,
): Promise<void> {
  const svc = supabaseService();
  const { error } = await svc.from("weekly_growth_runs").insert({
    workspace_id: workspaceId,
    window_start: windowStart,
    mode,
    status,
    summary: summary as unknown as import("@/lib/db/types").Json,
    detail,
  });
  if (error) {
    console.warn(`[weekly-growth] run record failed for ${workspaceId} (${windowStart}):`, error.message);
  }
}

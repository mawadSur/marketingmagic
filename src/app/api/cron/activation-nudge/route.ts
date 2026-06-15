import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  renderActivationNudgeEmail,
  activationNudgeSubject,
} from "@/lib/email/activation-nudge-template";

// "Connected but never published" lifecycle nudge. Runs daily 15:00 UTC from
// .github/workflows/cron-activation-nudge.yml. Auth: Bearer CRON_SECRET (same
// shape as the other cron routes). Service-role Supabase client throughout —
// RLS would block reads across workspaces.
//
// Re-engages the channel→published drop: a workspace that connected its FIRST
// channel but has never shipped a post gets one email nudging them to publish
// the post already waiting in their queue (primary CTA → the wizard's one-click
// first-publish step; /queue as the text fallback).
//
// ── IDEMPOTENCY WITHOUT A DB MIGRATION ──────────────────────────────────────
// We do NOT track "already nudged" in the DB. Instead we select only workspaces
// whose FIRST connected channel (min created_at where status='connected') falls
// inside the trailing [48h, 72h) window AND that have ZERO posts with
// status='posted'. Because that window is exactly 24h wide and the cron runs
// once a day, each qualifying workspace crosses it on ~one daily run — so it
// gets nudged at most once without any per-workspace flag.
//
// LIMITATION: this is window-based, not flag-based. If a cron run is missed
// (GitHub Actions outage, disabled schedule, etc.), the cohort whose window
// elapsed that day is skipped permanently — they age out past 72h and never get
// nudged. That's an acceptable tradeoff vs. adding a migration + a sent-flag
// column; a missed day costs us a single cohort's nudge, not a double-send.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_URL = "https://api.resend.com/emails";

// Trailing window bounds, in hours, for "first channel connected N hours ago".
// 48h lower / 72h upper → a 24h-wide window that aligns with the daily cron so
// each workspace qualifies on roughly one run.
const WINDOW_MIN_HOURS = 48;
const WINDOW_MAX_HOURS = 72;

interface NudgeResult {
  workspaceId: string;
  workspaceName: string;
  status: "sent" | "skipped" | "failed";
  recipient?: string;
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

  const env = serverEnv();
  // Ship-dark-safe: without a Resend key we cannot send anything, so no-op
  // gracefully like the digest siblings instead of throwing. (This nudge uses
  // no signed magic links, so EMAIL_LINK_SECRET is NOT required.)
  if (!env.RESEND_API_KEY) {
    return NextResponse.json({ scanned: 0, nudged: 0, skipped: "email not configured (RESEND_API_KEY)" });
  }

  const svc = supabaseService();
  const base = siteUrl();

  const now = Date.now();
  // [windowEnd, windowStart): rows whose first connect is OLDER than 48h but
  // NEWER than 72h. windowStart is the older bound (72h ago), windowEnd the
  // newer (48h ago).
  const windowStartIso = new Date(now - WINDOW_MAX_HOURS * 3600_000).toISOString();
  const windowEndIso = new Date(now - WINDOW_MIN_HOURS * 3600_000).toISOString();

  // 1. Pull every connected social account in (or near) the window. We can't
  //    express "min(created_at) per workspace" cleanly through the JS client,
  //    so we pull connected rows created on-or-before the newer bound and
  //    reduce to each workspace's earliest connect in JS. Bounded by the
  //    on-or-before filter; fine at expected workspace counts (low hundreds).
  const { data: accountRows, error: accErr } = await svc
    .from("social_accounts")
    .select("workspace_id, created_at")
    .eq("status", "connected")
    .lte("created_at", windowEndIso)
    .order("created_at", { ascending: true });
  if (accErr) {
    return NextResponse.json({ error: accErr.message }, { status: 500 });
  }

  // Earliest connected created_at per workspace.
  const firstConnectByWorkspace = new Map<string, string>();
  for (const row of accountRows ?? []) {
    if (!firstConnectByWorkspace.has(row.workspace_id)) {
      firstConnectByWorkspace.set(row.workspace_id, row.created_at);
    }
  }

  // Keep only workspaces whose FIRST connect falls inside [72h, 48h) ago.
  const candidateIds: string[] = [];
  for (const [wsId, firstAt] of firstConnectByWorkspace) {
    if (firstAt >= windowStartIso && firstAt < windowEndIso) {
      candidateIds.push(wsId);
    }
  }

  const scanned = candidateIds.length;
  if (scanned === 0) {
    return NextResponse.json({ scanned: 0, nudged: 0, results: [], at: new Date().toISOString() });
  }

  // 2. Drop any candidate that already has a 'posted' post — they've activated,
  //    so the nudge is moot. One query for all candidates.
  const { data: postedRows, error: postedErr } = await svc
    .from("posts")
    .select("workspace_id")
    .eq("status", "posted")
    .in("workspace_id", candidateIds);
  if (postedErr) {
    return NextResponse.json({ error: postedErr.message }, { status: 500 });
  }
  const activatedIds = new Set((postedRows ?? []).map((r) => r.workspace_id));
  const targetIds = candidateIds.filter((id) => !activatedIds.has(id));

  if (targetIds.length === 0) {
    return NextResponse.json({ scanned, nudged: 0, results: [], at: new Date().toISOString() });
  }

  const { data: workspaces, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id")
    .in("id", targetIds);
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  const results: NudgeResult[] = [];
  let nudged = 0;

  for (const ws of workspaces ?? []) {
    const result: NudgeResult = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      status: "skipped",
    };

    // Resolve the owner's email via the admin API. Skip quietly when the owner
    // row was deleted or has no email.
    const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ws.owner_id);
    if (userErr || !userResp?.user?.email) {
      result.reason = userErr?.message ?? "owner has no email";
      results.push(result);
      continue;
    }
    const recipient = userResp.user.email;
    result.recipient = recipient;

    const html = renderActivationNudgeEmail({
      workspaceName: ws.name,
      publishUrl: `${base}/onboarding/wizard?step=4`,
      queueUrl: `${base}/queue`,
    });

    try {
      const resp = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: recipient,
          subject: activationNudgeSubject(ws.name),
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        result.status = "failed";
        result.reason = `resend ${resp.status}: ${errText.slice(0, 300)}`;
      } else {
        result.status = "sent";
        nudged += 1;
      }
    } catch (err) {
      // Capture to Sentry so silently-broken crons are visible. Graceful no-op
      // when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "activation-nudge", workspace_id: ws.id, phase: "send" },
      });
      result.status = "failed";
      result.reason = err instanceof Error ? err.message : "fetch failed";
    }

    results.push(result);
  }

  return NextResponse.json({
    scanned,
    nudged,
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

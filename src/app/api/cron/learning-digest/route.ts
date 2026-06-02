import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  assembleLearningDigest,
  renderLearningDigest,
} from "@/lib/dashboard/learning-digest";

// "What we learned & changed" — weekly learning digest (Bet ①).
//
// Triggered weekly from .github/workflows/cron-learning-digest.yml; auth via
// Bearer CRON_SECRET (mirrors the other cron routes). For each workspace it
// assembles the confident theme winners + the latest AI review and emails the
// owner one branded summary via Resend.
//
// Why a SEPARATE weekly cron (not folded into engagement-report)?
//   • engagement-report runs DAILY and ships a per-channel metric rollup — a
//     different cadence and a different payload.
//   • the learning digest is WEEKLY and assembles theme winners + AI review.
//   Folding a weekly section into a daily email would either spam it daily or
//   need an awkward "is it the right weekday" gate inside the daily route. A
//   clean separate weekly cron matches the existing one-cron-per-concern
//   layout (10 sibling cron routes).
//
// GRACEFUL DEGRADE: when RESEND_API_KEY / EMAIL_FROM is unset we LOG + return
// 200 with a "not configured" note — never throw, exactly like the other
// digest crons.
// COLD START: assembleLearningDigest returns null when there are no confident
// winners AND no AI review yet; those workspaces are skipped (no empty email).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_URL = "https://api.resend.com/emails";

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

export async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    // Graceful degrade — log + skip, never throw. 200 so the cron job is green.
    console.warn(
      "[learning-digest] RESEND_API_KEY / EMAIL_FROM unset — skipping all sends.",
    );
    return NextResponse.json(
      { error: "email transport not configured (need RESEND_API_KEY + EMAIL_FROM)" },
      { status: 200 },
    );
  }

  const base = siteUrl();
  const svc = supabaseService();

  // All workspaces. Owner-only delivery mirrors engagement-report / email-digest
  // (both resolve owner_id → auth.users email). No email opt-out column exists
  // in the schema, so we don't invent one here.
  const { data: wsRows, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id");
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  const results: Array<{ workspaceId: string; status: string; reason?: string }> = [];

  for (const ws of wsRows ?? []) {
    // Assemble — returns null on cold start (no winners AND no review).
    let digest;
    try {
      digest = await assembleLearningDigest(ws.id, {
        workspaceName: ws.name,
        dashboardUrl: `${base}/dashboard`,
        analyticsUrl: `${base}/analytics`,
      });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        status: "failed",
        reason: err instanceof Error ? err.message : "assemble failed",
      });
      continue;
    }
    if (!digest) {
      skipped += 1;
      results.push({ workspaceId: ws.id, status: "skipped", reason: "cold_start_no_signal" });
      continue;
    }

    // Resolve the owner's email via the admin API.
    const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ws.owner_id);
    if (userErr || !userResp?.user?.email) {
      skipped += 1;
      results.push({
        workspaceId: ws.id,
        status: "skipped",
        reason: userErr?.message ?? "owner has no email",
      });
      continue;
    }
    const recipient = userResp.user.email;
    const html = renderLearningDigest(digest);

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
          subject: `What we learned & changed — ${ws.name}`,
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        results.push({
          workspaceId: ws.id,
          status: "failed",
          reason: `resend ${resp.status}: ${errText.slice(0, 200)}`,
        });
      } else {
        sent += 1;
        results.push({ workspaceId: ws.id, status: "sent" });
      }
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        status: "failed",
        reason: err instanceof Error ? err.message : "fetch failed",
      });
    }
  }

  return NextResponse.json({ checked: (wsRows ?? []).length, sent, skipped, results });
}

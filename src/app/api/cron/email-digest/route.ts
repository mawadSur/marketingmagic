import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { signLinkToken } from "@/lib/email/sign";
import { renderDigestEmail, type DigestPost } from "@/lib/email/digest-template";

// Daily approval digest. Runs 14:00 UTC from .github/workflows/cron-email-digest.yml.
// Auth: Bearer CRON_SECRET (same shape as the other cron routes). Service-role
// Supabase client used throughout — RLS would block reads across workspaces.
//
// For each workspace with ≥1 pending_approval post we send one email to the
// owner (workspace.owner_id → auth.users.email) containing up to 10 posts and
// HMAC-signed approve/reject magic links. Resend is called via raw fetch so
// we don't add an SDK dep.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_POSTS_PER_EMAIL = 10;
const RESEND_URL = "https://api.resend.com/emails";

interface EmailResult {
  workspaceId: string;
  workspaceName: string;
  status: "sent" | "skipped" | "failed";
  recipient?: string;
  pendingCount?: number;
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
  if (!env.RESEND_API_KEY) {
    return NextResponse.json({ skipped: "RESEND_API_KEY not set" });
  }
  if (!env.EMAIL_LINK_SECRET) {
    return NextResponse.json({ skipped: "EMAIL_LINK_SECRET not set" });
  }

  const svc = supabaseService();
  const base = siteUrl();
  const linkSecret = env.EMAIL_LINK_SECRET;

  // 1. Find workspaces with pending_approval posts. We do this in two steps
  //    because Supabase doesn't expose a clean "group by + having count > 0"
  //    over the JS client; pulling minimal columns and dedup'ing in JS is
  //    fine at expected workspace counts (low hundreds).
  const { data: pendingRows, error: pendErr } = await svc
    .from("posts")
    .select("workspace_id")
    .eq("status", "pending_approval");
  if (pendErr) {
    return NextResponse.json({ error: pendErr.message }, { status: 500 });
  }

  const workspaceIds = Array.from(new Set((pendingRows ?? []).map((r) => r.workspace_id)));
  if (workspaceIds.length === 0) {
    return NextResponse.json({ checked: 0, sent: 0, results: [] });
  }

  const { data: workspaces, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id")
    .in("id", workspaceIds);
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  const results: EmailResult[] = [];
  let sentCount = 0;

  for (const ws of workspaces ?? []) {
    const result: EmailResult = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      status: "skipped",
    };

    // Look up the owner's email via the admin API. Returns null user if the
    // owner row was deleted; we just skip those quietly.
    const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ws.owner_id);
    if (userErr || !userResp?.user?.email) {
      result.status = "skipped";
      result.reason = userErr?.message ?? "owner has no email";
      results.push(result);
      continue;
    }
    const recipient = userResp.user.email;
    result.recipient = recipient;

    // Pull the pending posts for this workspace (ordered: oldest first so the
    // most urgent ones are at the top of the email).
    const { data: posts, error: postsErr } = await svc
      .from("posts")
      .select("id, channel, theme, text, scheduled_at, created_at")
      .eq("workspace_id", ws.id)
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true })
      .limit(MAX_POSTS_PER_EMAIL + 50); // pull a little extra to count overflow
    if (postsErr) {
      result.status = "failed";
      result.reason = postsErr.message;
      results.push(result);
      continue;
    }

    const totalPending = posts?.length ?? 0;
    result.pendingCount = totalPending;
    if (totalPending === 0) {
      result.status = "skipped";
      result.reason = "no pending posts (race)";
      results.push(result);
      continue;
    }

    const top: DigestPost[] = (posts ?? []).slice(0, MAX_POSTS_PER_EMAIL).map((p) => ({
      id: p.id,
      channel: p.channel,
      theme: p.theme,
      text: p.text,
      scheduledAt: p.scheduled_at,
    }));

    const html = renderDigestEmail({
      workspaceName: ws.name,
      posts: top,
      totalPending,
      approveLinkFor: (postId) =>
        `${base}/api/approve?token=${encodeURIComponent(
          signLinkToken({ postId, action: "approve" }, linkSecret),
        )}`,
      rejectLinkFor: (postId) =>
        `${base}/api/reject?token=${encodeURIComponent(
          signLinkToken({ postId, action: "reject" }, linkSecret),
        )}`,
      queueUrl: `${base}/queue`,
    });

    const subject =
      totalPending === 1
        ? `1 post awaiting approval — ${ws.name}`
        : `${totalPending} posts awaiting approval — ${ws.name}`;

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
          subject,
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        result.status = "failed";
        result.reason = `resend ${resp.status}: ${errText.slice(0, 300)}`;
      } else {
        result.status = "sent";
        sentCount += 1;
      }
    } catch (err) {
      result.status = "failed";
      result.reason = err instanceof Error ? err.message : "fetch failed";
    }

    results.push(result);
  }

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    sent: sentCount,
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

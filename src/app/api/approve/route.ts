import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { verifyLinkToken } from "@/lib/email/sign";

// One-click approve magic-link endpoint. Auth is the signature on the token
// itself (HMAC-SHA256 over the payload using EMAIL_LINK_SECRET) — the user
// is not logged in when they click from email. Tokens are good for 24h and
// the action field is bound into the payload so an "approve" token can't be
// reused at /api/reject (and vice versa).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const env = serverEnv();
  const base = siteUrl();

  if (!env.EMAIL_LINK_SECRET) {
    // Graceful degrade — same pattern as the digest cron. Nothing to do.
    return NextResponse.redirect(`${base}/queue?digest=disabled`, { status: 303 });
  }

  const token = req.nextUrl.searchParams.get("token") ?? "";
  const verified = verifyLinkToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=${verified.reason}`, {
      status: 303,
    });
  }
  if (verified.payload.action !== "approve") {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=action-mismatch`, {
      status: 303,
    });
  }

  const svc = supabaseService();

  const { data: post, error: postErr } = await svc
    .from("posts")
    .select("id, status, workspace_id")
    .eq("id", verified.payload.postId)
    .maybeSingle();
  if (postErr || !post) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=missing`, { status: 303 });
  }
  if (post.status !== "pending_approval") {
    // Already actioned in the UI or another link. Idempotent: tell the user.
    return NextResponse.redirect(`${base}/queue?digest=stale`, { status: 303 });
  }

  const { data: ws, error: wsErr } = await svc
    .from("workspaces")
    .select("owner_id")
    .eq("id", post.workspace_id)
    .maybeSingle();
  if (wsErr || !ws) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=workspace`, { status: 303 });
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .eq("id", post.id);
  if (updateErr) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=update`, { status: 303 });
  }

  // Audit trail. Attributed to the workspace owner since the signed token
  // proves ownership of an email address we sent to.
  await svc.from("approvals").insert({
    post_id: post.id,
    user_id: ws.owner_id,
    action: "approved",
    diff: null,
  });

  return NextResponse.redirect(`${base}/queue?digest=approved`, { status: 303 });
}

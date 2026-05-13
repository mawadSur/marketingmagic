import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { verifyLinkToken } from "@/lib/email/sign";

// One-click reject magic-link endpoint. Symmetric with /api/approve. See that
// file for the security model — the action is bound into the signed payload
// so the two endpoints don't share tokens.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const env = serverEnv();
  const base = siteUrl();

  if (!env.EMAIL_LINK_SECRET) {
    return NextResponse.redirect(`${base}/queue?digest=disabled`, { status: 303 });
  }

  const token = req.nextUrl.searchParams.get("token") ?? "";
  const verified = verifyLinkToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=${verified.reason}`, {
      status: 303,
    });
  }
  if (verified.payload.action !== "reject") {
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

  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "rejected" })
    .eq("id", post.id);
  if (updateErr) {
    return NextResponse.redirect(`${base}/queue?digest=invalid&reason=update`, { status: 303 });
  }

  await svc.from("approvals").insert({
    post_id: post.id,
    user_id: ws.owner_id,
    action: "rejected",
    diff: null,
  });

  return NextResponse.redirect(`${base}/queue?digest=rejected`, { status: 303 });
}

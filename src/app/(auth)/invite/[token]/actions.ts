"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { serverEnv } from "@/lib/env";
import { verifyInvitationToken } from "@/lib/memberships/invitations";
import { setActiveWorkspaceCookie } from "@/lib/workspace";

export type AcceptResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string };

/**
 * Server action wired up to the "Accept" button on the invite page.
 *
 * Two-step flow:
 *   1. Caller must be authenticated. If not, the page redirects them to
 *      /login?next=/invite/<token> first; on successful auth they return
 *      here and this action runs.
 *   2. Action verifies the token, looks up the invitation row, ensures
 *      it's still pending, inserts a memberships row, flips accepted_at,
 *      and redirects into the new workspace's dashboard with the active
 *      workspace cookie set.
 *
 * Email match: we do NOT enforce that the accepting user's email matches
 * the invited email. The owner sent a magic link to a specific address;
 * if it was forwarded, that's the recipient's problem. This mirrors the
 * existing approve/reject magic-link policy.
 */
export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/login");

  const env = serverEnv();
  if (!env.EMAIL_LINK_SECRET) {
    redirect(`/invite/${encodeURIComponent(token)}?error=disabled`);
  }

  const verified = verifyInvitationToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    redirect(`/invite/${encodeURIComponent(token)}?error=${verified.reason}`);
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Visitor not logged in — bounce them through signup, preserving the
    // token so we land back here once they auth.
    redirect(`/signup?invite=${encodeURIComponent(token)}`);
  }

  const svc = supabaseService();

  // Pull the invitation row + workspace slug. Service-role bypass RLS so
  // the visitor (who is not yet a member) can read this single row.
  const { data: inv, error: invErr } = await svc
    .from("workspace_invitations")
    .select("id, workspace_id, email, role, accepted_at, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (invErr || !inv) {
    redirect(`/invite/${encodeURIComponent(token)}?error=missing`);
  }
  if (inv.accepted_at) {
    redirect(`/invite/${encodeURIComponent(token)}?error=already_used`);
  }
  if (new Date(inv.expires_at) < new Date()) {
    redirect(`/invite/${encodeURIComponent(token)}?error=expired`);
  }

  // Pull workspace slug for the redirect.
  const { data: ws, error: wsErr } = await svc
    .from("workspaces")
    .select("id, slug, owner_id")
    .eq("id", inv.workspace_id)
    .maybeSingle();
  if (wsErr || !ws) {
    redirect(`/invite/${encodeURIComponent(token)}?error=missing`);
  }

  // If the user is already the owner or already has a membership, just
  // mark the invite consumed and forward into the workspace.
  if (ws.owner_id === user.id) {
    await svc
      .from("workspace_invitations")
      .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
      .eq("id", inv.id);
    await setActiveWorkspaceCookie(ws.slug);
    revalidatePath("/", "layout");
    redirect("/dashboard");
  }

  const { data: existing } = await svc
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", inv.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) {
    const { error: memErr } = await svc.from("memberships").insert({
      workspace_id: inv.workspace_id,
      user_id: user.id,
      role: inv.role,
    });
    if (memErr) {
      redirect(`/invite/${encodeURIComponent(token)}?error=insert_failed`);
    }
  }

  await svc
    .from("workspace_invitations")
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", inv.id);

  await setActiveWorkspaceCookie(ws.slug);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Decline silently — flips accepted_at to a sentinel "declined" marker by
 * using the current time and accepted_by = null (we still set accepted_at
 * so the link can't be reused). Just a redirect; we don't insert anything.
 */
export async function declineInvitationAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/login");

  const env = serverEnv();
  if (!env.EMAIL_LINK_SECRET) redirect("/login");

  const verified = verifyInvitationToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) redirect("/login");

  const svc = supabaseService();
  // Mark accepted_at so the link is consumed; accepted_by left null so
  // we can tell apart accepted vs declined in the owner's view later if
  // we ever surface that.
  await svc
    .from("workspace_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("token", token)
    .is("accepted_at", null);

  redirect("/login?invite=declined");
}

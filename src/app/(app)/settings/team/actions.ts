"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { serverEnv, siteUrl } from "@/lib/env";
import {
  signInvitationToken,
  sendInvitationEmail,
  type InvitationRole,
} from "@/lib/memberships/invitations";

export type InviteState = {
  error: string | null;
  info: string | null;
  inviteUrl: string | null;
};

const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(254),
  role: z.enum(["editor", "viewer"]),
});

/**
 * Owner-only check: returns null if the current user owns the active
 * workspace, otherwise an error message. Used by every mutation in this
 * file to enforce that only owners change team state.
 */
async function requireOwner(): Promise<{ workspaceId: string; userId: string } | { error: string }> {
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();
  if (ws.owner_id !== user.id) {
    return { error: "Only workspace owners can manage the team." };
  }
  return { workspaceId: ws.id, userId: user.id };
}

/**
 * Send (or print) an invitation to an email + role for the active workspace.
 *
 * Two paths:
 *   * RESEND_API_KEY + EMAIL_LINK_SECRET both set → send the email and
 *     return a friendly "Invitation sent" message.
 *   * Either secret missing → fall back to surfacing the magic link in
 *     the UI so the owner can copy-paste it manually. This keeps the
 *     team feature functional in dev / preview without secrets.
 */
export async function inviteMemberAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const auth = await requireOwner();
  if ("error" in auth) {
    return { error: auth.error, info: null, inviteUrl: null };
  }
  const env = serverEnv();
  if (!env.EMAIL_LINK_SECRET) {
    return {
      error:
        "EMAIL_LINK_SECRET is not set. Configure it to enable invitations (same secret used by the email digest).",
      info: null,
      inviteUrl: null,
    };
  }

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      info: null,
      inviteUrl: null,
    };
  }

  const supabase = await supabaseServer();
  const svc = supabaseService();

  // Look up the workspace info we need for the email (name) and the
  // inviter's email (for the email body).
  const { data: ws, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", auth.workspaceId)
    .maybeSingle();
  if (wsErr || !ws) {
    return { error: wsErr?.message ?? "Workspace not found.", info: null, inviteUrl: null };
  }

  // Check: is this email already a member? Use service-role to look up the
  // auth user, then check memberships and owner.
  const { data: existingUserResp } = await svc.auth.admin
    .listUsers({ page: 1, perPage: 1 })
    .catch(() => ({ data: null as { users: unknown[] } | null }));
  // The listUsers admin API doesn't support email filtering directly in this
  // SDK version, so we look up by iterating with a small filter via the
  // service client. In practice we check by querying auth.users via a
  // separate index (not exposed). Easiest is: insert the invitation row
  // regardless of existing membership — the acceptance page will refuse if
  // they're already a member. Suppress unused warning.
  void existingUserResp;

  // Bail early if there's already a pending invitation for this email.
  const { data: existingInvite } = await svc
    .from("workspace_invitations")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("email", parsed.data.email)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existingInvite) {
    return {
      error: `An invitation to ${parsed.data.email} is already pending. Revoke it first if you want to re-send.`,
      info: null,
      inviteUrl: null,
    };
  }

  // Insert invitation row first so we have an id to bind to the token.
  // Token is set in a second update because it carries the row id in its payload.
  const { data: row, error: insertErr } = await svc
    .from("workspace_invitations")
    .insert({
      workspace_id: auth.workspaceId,
      email: parsed.data.email,
      role: parsed.data.role as InvitationRole,
      invited_by: auth.userId,
      // Placeholder token; replaced below. Token is unique so we use the
      // row id (with a prefix that won't collide with real tokens).
      token: `pending-${crypto.randomUUID()}`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !row) {
    return { error: insertErr?.message ?? "Failed to create invitation.", info: null, inviteUrl: null };
  }

  const { token, expiresAt } = signInvitationToken(
    {
      invitationId: row.id,
      workspaceId: auth.workspaceId,
      email: parsed.data.email,
    },
    env.EMAIL_LINK_SECRET,
  );

  const { error: tokenErr } = await svc
    .from("workspace_invitations")
    .update({ token, expires_at: expiresAt.toISOString() })
    .eq("id", row.id);
  if (tokenErr) {
    return { error: tokenErr.message, info: null, inviteUrl: null };
  }

  const inviteUrl = `${siteUrl()}/invite/${encodeURIComponent(token)}`;

  // Send email if configured. Otherwise surface the link.
  if (env.RESEND_API_KEY) {
    const inviter = await svc.auth.admin.getUserById(auth.userId);
    const inviterEmail = inviter.data?.user?.email ?? "a teammate";
    const result = await sendInvitationEmail({
      to: parsed.data.email,
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      workspaceName: ws.name,
      inviterEmail,
      inviteUrl,
      role: parsed.data.role as InvitationRole,
      expiresAt,
    });
    revalidatePath("/settings/team");
    if (!result.ok) {
      // Don't lose the invite if the email send fails — surface the link
      // as a fallback so the owner can share it manually.
      return {
        error: `Email send failed: ${result.error}. Share this link manually instead:`,
        info: null,
        inviteUrl,
      };
    }
    return {
      error: null,
      info: `Invitation sent to ${parsed.data.email}.`,
      inviteUrl: null,
    };
  }

  revalidatePath("/settings/team");
  return {
    error: null,
    info: `RESEND_API_KEY not set — share this invite link manually:`,
    inviteUrl,
  };
}

// ─── Revoke / remove / role change ─────────────────────────────────────

const idSchema = z.string().uuid();

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if ("error" in auth) return;

  const id = idSchema.safeParse(formData.get("invitation_id"));
  if (!id.success) return;

  const svc = supabaseService();
  // Scope to this workspace; never let an owner revoke someone else's invite.
  await svc
    .from("workspace_invitations")
    .delete()
    .eq("id", id.data)
    .eq("workspace_id", auth.workspaceId);

  revalidatePath("/settings/team");
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if ("error" in auth) return;

  const memberId = idSchema.safeParse(formData.get("user_id"));
  if (!memberId.success) return;

  // Refuse to remove the owner — owners are removed by transferring
  // ownership, which is a separate flow we don't ship yet.
  if (memberId.data === auth.userId) return;

  const svc = supabaseService();
  await svc
    .from("memberships")
    .delete()
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", memberId.data);

  revalidatePath("/settings/team");
}

const roleSchema = z.enum(["editor", "viewer"]);

export async function changeRoleAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if ("error" in auth) return;

  const memberId = idSchema.safeParse(formData.get("user_id"));
  const role = roleSchema.safeParse(formData.get("role"));
  if (!memberId.success || !role.success) return;
  if (memberId.data === auth.userId) return; // can't change owner's role

  const svc = supabaseService();
  await svc
    .from("memberships")
    .update({ role: role.data })
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", memberId.data);

  revalidatePath("/settings/team");
}

// Used by /settings/team as a redirect target when the visitor isn't an owner.
export async function bounceNonOwnerAction(): Promise<void> {
  redirect("/dashboard");
}

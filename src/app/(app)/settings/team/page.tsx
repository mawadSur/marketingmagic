import { redirect } from "next/navigation";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { TeamMemberRow, type TeamMemberRowData } from "@/components/team-member-row";
import { InviteForm } from "./invite-form";
import { revokeInvitationAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /settings/team — invite, list, and manage workspace members.
 *
 * Page-level guard: only the workspace owner sees the management UI.
 * Non-owners (editors / viewers) get redirected to /dashboard because
 * team management is owner-only by design (per migration 010 RLS).
 */
export default async function TeamPage() {
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();
  if (ws.owner_id !== user.id) {
    redirect("/dashboard");
  }

  const svc = supabaseService();

  // Members: owner row first (from workspaces.owner_id), then memberships.
  // The owner row isn't necessarily in memberships (it can be — but the
  // workspace creator path doesn't auto-insert). We hydrate both and dedupe.
  const [{ data: memberships }, { data: pendingInvites }] = await Promise.all([
    svc
      .from("memberships")
      .select("user_id, role, created_at")
      .eq("workspace_id", ws.id)
      .order("created_at", { ascending: true }),
    svc
      .from("workspace_invitations")
      .select("id, email, role, expires_at, created_at, accepted_at")
      .eq("workspace_id", ws.id)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);

  // Collect all user_ids we need to look up emails for, owner included.
  const userIds = new Set<string>([ws.owner_id]);
  for (const m of memberships ?? []) {
    userIds.add(m.user_id);
  }

  // Hydrate emails via the admin API (one lookup per id). We expect <50
  // members per workspace — fine for the dashboard view.
  const emailMap = new Map<string, string>();
  for (const id of userIds) {
    const { data } = await svc.auth.admin.getUserById(id);
    if (data?.user?.email) emailMap.set(id, data.user.email);
  }

  const members: TeamMemberRowData[] = [];
  // Owner row.
  members.push({
    userId: ws.owner_id,
    email: emailMap.get(ws.owner_id) ?? "(unknown)",
    role: "owner",
    joinedAt: ws.created_at,
    isMe: ws.owner_id === user.id,
  });
  // Membership rows (skip duplicates of owner).
  for (const m of memberships ?? []) {
    if (m.user_id === ws.owner_id) continue; // owner already listed
    members.push({
      userId: m.user_id,
      email: emailMap.get(m.user_id) ?? "(unknown)",
      role: m.role,
      joinedAt: m.created_at,
      isMe: m.user_id === user.id,
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Invite teammates to <strong>{ws.name}</strong>. Editors can draft and approve;
          viewers can only read. Only the workspace owner can manage the team.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Invite a teammate</h2>
        <div className="rounded-lg border bg-card p-5">
          <InviteForm />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Members</h2>
          <p className="text-xs text-muted-foreground">
            {members.length} {members.length === 1 ? "person" : "people"}
          </p>
        </div>
        <ul className="space-y-2">
          {members.map((m) => (
            <TeamMemberRow key={m.userId} member={m} canManage />
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Pending invitations</h2>
          <p className="text-xs text-muted-foreground">
            {pendingInvites?.length ?? 0} pending
          </p>
        </div>
        {!pendingInvites || pendingInvites.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No pending invitations."
            description="Invitations expire after 7 days. Send a new one above."
          />
        ) : (
          <ul className="space-y-2">
            {pendingInvites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(inv.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="muted">{inv.role}</Badge>
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitation_id" value={inv.id} />
                    <button
                      type="submit"
                      className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    >
                      Revoke
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

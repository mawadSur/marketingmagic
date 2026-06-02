import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveClientAccount, getClientWorkspaceReport } from "@/lib/portal/account";
import { ClientReportView } from "./client-report-view";

export const dynamic = "force-dynamic";

// /portal — the authenticated CLIENT landing page (migration 037).
//
// SECURITY: resolveClientAccount reads client_memberships through the AUTHED
// (RLS-backed) client, so it returns ONLY this user's links. A user with no
// client memberships is not a client → bounce to /login (they have nothing
// here; if they're an agency user the (app) shell handles them). When the
// client is linked to exactly one workspace we render it inline; multiple → a
// picker. Every report read is independently re-gated by user_is_client_of.
export default async function ClientPortalHome() {
  const account = await resolveClientAccount();
  if (!account) redirect("/login");

  // Single workspace → render its report directly (no needless picker step).
  if (account.workspaces.length === 1) {
    const ws = account.workspaces[0]!;
    const data = await getClientWorkspaceReport(ws.workspaceId);
    if (!data) redirect("/login"); // membership lost between resolve + read.
    return <ClientReportView data={data} showSwitchLink={false} />;
  }

  // Multiple workspaces → let the client pick which report to view.
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Your reports</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Pick a workspace to view its performance report.
      </p>
      <ul className="space-y-3">
        {account.workspaces.map((ws) => (
          <li key={ws.workspaceId}>
            <Link
              href={`/portal/${ws.workspaceId}`}
              className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/50"
              prefetch={false}
            >
              <span>{ws.workspaceName}</span>
              <span aria-hidden className="text-muted-foreground">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

import { redirect } from "next/navigation";
import { resolveClientAccount, getClientWorkspaceReport } from "@/lib/portal/account";
import { ClientReportView } from "../client-report-view";

export const dynamic = "force-dynamic";

// /portal/[workspaceId] — a specific workspace's report for an authenticated
// client (migration 037). This is the CROSS-TENANT ISOLATION surface: a client
// could put ANY workspace id in the URL. getClientWorkspaceReport re-gates the
// id with user_is_client_of(ws) under the caller's session BEFORE any read, so
// a workspace the caller isn't linked to returns null → we redirect to /portal
// and leak nothing (not even existence). No data is fetched until the gate
// passes.
export default async function ClientWorkspaceReportPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const account = await resolveClientAccount();
  if (!account) redirect("/login");

  // The gate lives inside getClientWorkspaceReport (user_is_client_of). A
  // forged/unlinked id yields null and we bounce back to the picker — never an
  // error that distinguishes "exists but not yours" from "doesn't exist".
  const data = await getClientWorkspaceReport(workspaceId);
  if (!data) redirect("/portal");

  return (
    <ClientReportView data={data} showSwitchLink={account.workspaces.length > 1} />
  );
}

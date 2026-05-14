import { getActiveWorkspaceOrRedirect, listWorkspaces } from "@/lib/workspace";
import { AppHeader } from "@/components/app-header";
import { WorkspaceSwitcherCmdK } from "@/components/workspace-switcher-cmdk";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const active = await getActiveWorkspaceOrRedirect();
  const workspaces = await listWorkspaces();
  return (
    <div className="min-h-screen bg-background">
      <AppHeader active={active} workspaces={workspaces} />
      <div className="container py-8">{children}</div>
      {workspaces.length >= 2 ? (
        <WorkspaceSwitcherCmdK workspaces={workspaces} activeSlug={active.slug} />
      ) : null}
    </div>
  );
}

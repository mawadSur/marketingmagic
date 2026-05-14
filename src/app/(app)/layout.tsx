import {
  getActiveWorkspaceOrRedirect,
  getAuthedUserOrRedirect,
  listWorkspaces,
} from "@/lib/workspace";
import { AppHeader } from "@/components/app-header";
import { WorkspaceSwitcherCmdK } from "@/components/workspace-switcher-cmdk";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthedUserOrRedirect();
  const active = await getActiveWorkspaceOrRedirect();
  const workspaces = await listWorkspaces();
  const isOwner = active.owner_id === user.id;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader active={active} workspaces={workspaces} isOwner={isOwner} />
      <div className="container py-8">{children}</div>
      {workspaces.length >= 2 ? (
        <WorkspaceSwitcherCmdK workspaces={workspaces} activeSlug={active.slug} />
      ) : null}
    </div>
  );
}

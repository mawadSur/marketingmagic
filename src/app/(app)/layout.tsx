import {
  getActiveWorkspaceOrRedirect,
  getAuthedUserOrRedirect,
  listWorkspaces,
} from "@/lib/workspace";
import { readPinnedIds, readRecentIds } from "@/lib/workspace-prefs";
import { getPostsShipped7dByWorkspace } from "@/lib/portfolio/switcher-stats";
import { AppHeader } from "@/components/app-header";
import { WorkspaceSwitcherCmdK } from "@/components/workspace-switcher-cmdk";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthedUserOrRedirect();
  const active = await getActiveWorkspaceOrRedirect();
  const workspaces = await listWorkspaces();
  const isOwner = active.owner_id === user.id;

  // Only fetch pin/recent state + post counts when the switcher would
  // render (≥2 workspaces). Saves a DB roundtrip on single-workspace users.
  const showSwitcher = workspaces.length >= 2;
  const [pinnedIds, recentIds, postCountsMap] = showSwitcher
    ? await Promise.all([
        readPinnedIds(),
        readRecentIds(),
        getPostsShipped7dByWorkspace(workspaces.map((w) => w.id)),
      ])
    : [[] as string[], [] as string[], new Map<string, number>()];

  const postCounts: Record<string, number> = {};
  postCountsMap.forEach((value, key) => {
    postCounts[key] = value;
  });

  return (
    <div className="min-h-screen bg-background">
      <AppHeader active={active} workspaces={workspaces} isOwner={isOwner} />
      <div className="container py-8">{children}</div>
      {showSwitcher ? (
        <WorkspaceSwitcherCmdK
          workspaces={workspaces}
          activeSlug={active.slug}
          pinnedIds={pinnedIds}
          recentIds={recentIds}
          postCounts={postCounts}
        />
      ) : null}
    </div>
  );
}

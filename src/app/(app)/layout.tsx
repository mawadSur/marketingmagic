import {
  blockClientsFromAgencyApp,
  getActiveWorkspaceOrRedirect,
  getAuthedUserOrRedirect,
  listWorkspaces,
} from "@/lib/workspace";
import { readPinnedIds, readRecentIds } from "@/lib/workspace-prefs";
import { getPostsShipped7dByWorkspace } from "@/lib/portfolio/switcher-stats";
import { supabaseServer } from "@/lib/supabase/server";
import { AppHeader } from "@/components/app-header";
import { NoChannelsBanner } from "@/components/no-channels-banner";
import { WorkspaceSwitcherCmdK } from "@/components/workspace-switcher-cmdk";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthedUserOrRedirect();
  // Client ACCOUNTS guard (migration 037): a client (no agency footprint + has
  // client_memberships) is redirected to /portal here, BEFORE any agency page
  // renders — they can never load /dashboard, /queue, /plans, /settings, etc.
  // Agency/solo users pass through untouched.
  await blockClientsFromAgencyApp();
  const active = await getActiveWorkspaceOrRedirect();
  const workspaces = await listWorkspaces();
  const isOwner = active.owner_id === user.id;

  // Only fetch pin/recent state + post counts when the switcher would
  // render (≥2 workspaces). Saves a DB roundtrip on single-workspace users.
  const showSwitcher = workspaces.length >= 2;
  const supabase = await supabaseServer();
  const [pinnedIds, recentIds, postCountsMap, connectedCountRes] = await Promise.all([
    showSwitcher ? readPinnedIds() : Promise.resolve([] as string[]),
    showSwitcher ? readRecentIds() : Promise.resolve([] as string[]),
    showSwitcher
      ? getPostsShipped7dByWorkspace(workspaces.map((w) => w.id))
      : Promise.resolve(new Map<string, number>()),
    supabase
      .from("social_accounts_safe")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", active.id)
      .eq("status", "connected"),
  ]);

  const postCounts: Record<string, number> = {};
  postCountsMap.forEach((value, key) => {
    postCounts[key] = value;
  });

  const hasNoConnectedChannels = (connectedCountRes.count ?? 0) === 0;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader active={active} workspaces={workspaces} isOwner={isOwner} />
      {hasNoConnectedChannels ? <NoChannelsBanner /> : null}
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

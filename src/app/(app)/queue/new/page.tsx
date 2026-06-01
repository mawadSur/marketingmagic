import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { ComposeForm, type ConnectedChannel } from "./compose-form";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Only connected channels can receive a post — surface those as the
  // picker options. RLS scopes social_accounts_safe to the workspace.
  const { data: accounts } = await supabase
    .from("social_accounts_safe")
    .select("channel, handle")
    .eq("workspace_id", ws.id)
    .eq("status", "connected");

  const channels: ConnectedChannel[] = (accounts ?? [])
    .filter((a) => ENABLED_CHANNELS.includes(a.channel as ChannelId))
    .map((a) => ({
      channel: a.channel,
      label: channelSpec(a.channel)?.label ?? a.channel,
      handle: a.handle,
    }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <Link
          href="/queue"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          ← Back to queue
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Compose a post</h1>
      </header>
      <ComposeForm channels={channels} />
    </div>
  );
}

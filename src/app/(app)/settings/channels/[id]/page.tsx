import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { TrustToggle } from "./trust-toggle";
import { DisconnectButton } from "./disconnect-button";

export const dynamic = "force-dynamic";

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: account } = await supabase
    .from("social_accounts_safe")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!account) notFound();

  const eligible = account.successful_post_count >= account.trust_threshold;
  const isDisconnected = account.status === "disconnected";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            {account.channel} · @{account.handle}
          </h1>
          <Link href="/settings/channels" className="text-sm text-muted-foreground hover:text-foreground">
            ← All channels
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {isDisconnected
            ? "Disconnected. Reconnect from the channels list to post again — your history is kept."
            : account.trust_mode
              ? `${account.successful_post_count} successful posts. Auto-scheduling enabled — drafts skip approval and post with a 24h preview window.`
              : eligible
                ? `${account.successful_post_count} successful posts. Eligible for auto-scheduling. Enable below — you can revoke any time.`
                : `${account.successful_post_count} successful posts. ${account.trust_threshold - account.successful_post_count} more successful posts until eligible.`}
        </p>
      </header>

      {isDisconnected ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          This channel is disconnected.{" "}
          <Link href="/settings/channels" className="font-medium text-foreground underline-offset-4 hover:underline">
            Reconnect from the channels list →
          </Link>
        </div>
      ) : (
        <>
          <TrustToggle
            accountId={account.id}
            trustMode={account.trust_mode}
            eligible={eligible || account.trust_mode}
          />

          <DisconnectButton
            accountId={account.id}
            channel={account.channel}
            handle={account.handle}
          />
        </>
      )}
    </div>
  );
}

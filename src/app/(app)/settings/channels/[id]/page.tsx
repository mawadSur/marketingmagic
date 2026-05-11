import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { TrustToggle } from "./trust-toggle";

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
          {account.successful_post_count} successful posts.{" "}
          {account.trust_mode
            ? "Auto-scheduling enabled — drafts skip approval and post with a 24h preview window."
            : eligible
              ? "Eligible for auto-scheduling. Enable below — you can revoke any time."
              : `${account.trust_threshold - account.successful_post_count} more successful posts until eligible.`}
        </p>
      </header>

      <TrustToggle
        accountId={account.id}
        trustMode={account.trust_mode}
        eligible={eligible || account.trust_mode}
      />
    </div>
  );
}

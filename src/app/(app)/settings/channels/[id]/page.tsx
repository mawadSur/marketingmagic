import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import {
  isAutoReplyChannel,
  parseEngagementMode,
  dmCapabilityHint,
} from "@/lib/interactions/auto-reply/policy";
import { parseLeadKeywordRule } from "@/lib/interactions/auto-reply/lead-capture";
import { leadRuleToForm } from "@/lib/interactions/auto-reply/lead-rule-input";
import { Notice } from "@/components/ui/notice";
import { TrustToggle } from "./trust-toggle";
import { AutoReplyToggle } from "./auto-reply-toggle";
import { DmCaptureToggle, LeadRuleEditor } from "./dm-capture";
import { DisconnectButton } from "./disconnect-button";

// IG / Threads reply + DM paths are blocked on Meta App Review. We surface them
// as "pending review" rather than offering a dead toggle.
const META_PENDING_CHANNELS = new Set(["instagram", "threads"]);

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

  // The safe view omits the engagement columns; read the tri-state modes
  // (source of truth, migration 048) + the lead-keyword rule off the base
  // table (member-RLS-gated), along with the workspace kill switch.
  const [{ data: autoReplyRow }, { data: wsRow }] = await Promise.all([
    supabase
      .from("social_accounts")
      .select("auto_reply_mode, dm_capture_mode, lead_keyword_rule")
      .eq("id", id)
      .eq("workspace_id", ws.id)
      .maybeSingle(),
    supabase
      .from("workspaces")
      .select("auto_reply_kill_switch")
      .eq("id", ws.id)
      .maybeSingle(),
  ]);

  const eligible = account.successful_post_count >= account.trust_threshold;
  const isDisconnected = account.status === "disconnected";
  const supportsComms = isAutoReplyChannel(account.channel);
  const metaPending = META_PENDING_CHANNELS.has(account.channel);
  const leadForm = leadRuleToForm(
    parseLeadKeywordRule(autoReplyRow?.lead_keyword_rule),
  );

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

          <Notice variant="warning" title="Autonomous community engagement is off by default">
            The toggles below let this channel reply to mentions and DM
            commenters <em>automatically, with no human in the loop</em> —
            sending public and private content on your behalf. Everything starts
            OFF and requires trust mode. The workspace kill switch (in the
            auto-reply panel) is a one-click hard stop for every autonomous send.
          </Notice>

          {metaPending ? (
            <Notice variant="info" title="Instagram & Threads — pending Meta review">
              Auto-reply and comment→DM for {account.channel} are blocked on Meta
              App Review (the comment/messaging scopes aren&apos;t granted yet).
              They&apos;ll become toggleable here once Meta approves — there&apos;s
              nothing to configure today.
            </Notice>
          ) : null}

          <AutoReplyToggle
            accountId={account.id}
            channel={account.channel}
            trustMode={account.trust_mode}
            mode={parseEngagementMode(autoReplyRow?.auto_reply_mode)}
            supported={supportsComms}
            killSwitchEngaged={wsRow?.auto_reply_kill_switch ?? false}
          />

          <DmCaptureToggle
            accountId={account.id}
            channel={account.channel}
            trustMode={account.trust_mode}
            mode={parseEngagementMode(autoReplyRow?.dm_capture_mode)}
            supported={supportsComms}
            killSwitchEngaged={wsRow?.auto_reply_kill_switch ?? false}
            capability={dmCapabilityHint(account.channel)}
          />

          <LeadRuleEditor
            accountId={account.id}
            channel={account.channel}
            supported={supportsComms}
            initial={leadForm}
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

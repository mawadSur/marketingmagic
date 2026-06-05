import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { CHANNELS, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { mptConfigured, byoKeysConfigured, referenceVideoEnabled } from "@/lib/env";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { listAvatars } from "@/lib/video/avatars";
import { EmptyState } from "@/components/ui/empty-state";
import { NewPlanForm } from "./new-plan-form";

export const dynamic = "force-dynamic";

export default async function NewPlanPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("id").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle")
      .eq("workspace_id", ws.id)
      .eq("status", "connected")
      .order("created_at", { ascending: true }),
  ]);

  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as (typeof ENABLED_CHANNELS)[number]),
  );

  if (!briefRes.data) {
    return (
      <PreflightWrapper title="One step first: write a brief">
        <EmptyState
          icon="doc"
          title="Add a brand brief."
          description="Claude reads the brief to nail voice, audience, and the things you don't say."
          action={
            <Link
              href="/settings/brief"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Write your brief →
            </Link>
          }
        />
      </PreflightWrapper>
    );
  }
  if (accounts.length === 0) {
    return (
      <PreflightWrapper title="Connect a channel first">
        <EmptyState
          icon="plug"
          title="No channels connected."
          description="Hook up at least one social account so plans have somewhere to ship."
          action={
            <Link
              href="/settings/channels"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Connect a channel →
            </Link>
          }
        />
      </PreflightWrapper>
    );
  }

  // Plan videos — surface a per-channel "generate a video" checkbox ONLY when
  // video is actually available (the render worker + BYO encryption are wired
  // up AND this workspace has its own LLM + Pexels keys). When unavailable we
  // pass videoAvailable=false and the form shows a subtle "add keys" hint
  // instead of the checkboxes. We also hand the form the set of accountIds whose
  // channel supports video, so it only renders the checkbox where it can work.
  // The key status (presence-only booleans, never plaintext) feeds BOTH the MPT
  // video gate (llm + pexels) and the UGC gate (higgsfield) — fetch it once.
  const videoInfra = mptConfigured() && byoKeysConfigured();
  const ugcInfra = referenceVideoEnabled();
  let keyStatus: Awaited<ReturnType<typeof getWorkspaceKeyStatus>> | null = null;
  if (videoInfra || ugcInfra) {
    keyStatus = await getWorkspaceKeyStatus(ws.id);
  }
  const videoAvailable = videoInfra && !!keyStatus?.llm && !!keyStatus?.pexels;
  const videoCapableAccountIds = accounts
    .filter((a) => CHANNELS[a.channel as ChannelId]?.supportsVideo)
    .map((a) => a.id);

  // UGC avatar video — surface a per-channel "Generate UGC avatar video" checkbox
  // only when the deployment has the reference-video feature on AND the workspace
  // has a Higgsfield key on file. Whether the workspace has a SAVED avatar drives
  // the form's split: with an avatar we show the checkbox; without one we show a
  // hint linking to /settings/avatars instead. UGC reuses the same video-capable
  // channel set (short-form vertical clips). The avatar count is only needed when
  // the infra+key gate already passes, so we skip the query otherwise.
  const ugcKeyAvailable = ugcInfra && !!keyStatus?.higgsfield_video;
  let ugcHasAvatar = false;
  if (ugcKeyAvailable) {
    try {
      ugcHasAvatar = (await listAvatars(ws.id)).length > 0;
    } catch {
      // A listing failure must not break plan generation — fall back to "no
      // avatar" (the form then shows the add-avatar hint, not the checkbox).
      ugcHasAvatar = false;
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">New plan</p>
        <h1 className="text-3xl font-semibold tracking-tight">Generate a plan</h1>
        <p className="text-sm text-muted-foreground">
          Pick channels and cadence. Claude drafts every post — they land in the queue as pending approval
          (or auto-scheduled for accounts in trust mode).
        </p>
      </header>
      <NewPlanForm
        accounts={accounts}
        videoAvailable={videoAvailable}
        videoCapableAccountIds={videoCapableAccountIds}
        ugcKeyAvailable={ugcKeyAvailable}
        ugcHasAvatar={ugcHasAvatar}
      />
    </div>
  );
}

function PreflightWrapper({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <p className="label-eyebrow">New plan</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      </header>
      {children}
    </div>
  );
}

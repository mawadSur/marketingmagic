import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { mptConfigured, byoKeysConfigured, videoPublishEnabled } from "@/lib/env";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { tierFor } from "@/lib/billing/tiers";
import { getUsageSnapshot } from "@/lib/billing/usage";
import { supabaseService } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/types";
import type { VideoJobStatus } from "@/lib/video/jobs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GenerateVideoForm } from "./generate-form";
import { JobList, type JobListItem } from "./job-list";

export const dynamic = "force-dynamic";

function paramString(params: Json, key: string, fallback: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

export default async function VideoPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  const mpt = mptConfigured();
  const byo = byoKeysConfigured();
  if (!mpt || !byo) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Video</h1>
          <p className="text-sm text-muted-foreground">Generate short videos from a subject.</p>
        </header>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Video generation isn&apos;t available on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            {!mpt && (
              <>
                The render worker isn&apos;t configured (<code>MPT_BASE_URL</code> /{" "}
                <code>MPT_API_TOKEN</code>).{" "}
              </>
            )}
            {!byo && (
              <>
                Credential encryption isn&apos;t configured (<code>BYO_ENCRYPTION_KEY</code>).
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  // Presence-only key status + this workspace's plan/usage for the header.
  const [keyStatus, usage] = await Promise.all([
    getWorkspaceKeyStatus(ws.id),
    getUsageSnapshot(ws.id),
  ]);
  const limit = tierFor(ws.plan).limits.videosPerMonth;
  const usageLabel =
    limit === -1 ? `${usage.videosGenerated} / ∞` : `${usage.videosGenerated} / ${limit}`;
  const keysReady = keyStatus.llm && keyStatus.pexels;

  // Jobs are read through the user-scoped server client so workspace RLS is
  // the source of truth — a member only ever sees their own workspace's jobs.
  const supabase = await supabaseServer();
  const { data: rows } = await supabase
    .from("video_jobs")
    .select("id, status, progress, params, failure_reason, created_at")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const jobs: JobListItem[] = (rows ?? []).map((r) => ({
    id: r.id,
    status: r.status as VideoJobStatus,
    progress: r.progress ?? 0,
    subject: paramString(r.params, "video_subject", "Untitled video"),
    aspect: paramString(r.params, "video_aspect", "9:16"),
    failureReason: r.failure_reason ?? null,
    createdAt: r.created_at,
  }));

  // Connected, video-capable channels the user can publish the render to. The
  // chosen account flows to video_jobs.social_account_id so the poll cron can
  // attach the finished mp4 to a draft post; "Save to library" (no account)
  // renders without creating a draft. We hint when a channel's video
  // publishing isn't enabled yet (gated by VIDEO_PUBLISH_CHANNELS).
  const { data: accountRows } = await supabase
    .from("social_accounts_safe")
    .select("id, channel, handle")
    .eq("workspace_id", ws.id)
    .eq("status", "connected")
    .order("channel", { ascending: true });

  const accounts = (accountRows ?? [])
    .filter((a) => CHANNELS[a.channel as ChannelId]?.supportsVideo)
    .map((a) => {
      const enabled = videoPublishEnabled(a.channel);
      const label = `${CHANNELS[a.channel as ChannelId]?.label ?? a.channel} — ${a.handle}`;
      return { id: a.id, label: enabled ? label : `${label} (publishing not enabled yet)` };
    });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Video</h1>
          <p className="text-sm text-muted-foreground">
            Turn a subject into a short video using your own LLM + Pexels keys.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p className="uppercase tracking-wide">Renders this month</p>
          <p className={"text-sm font-medium " + (limit === 0 ? "text-destructive" : "text-foreground")}>
            {limit === 0 ? "Not included on your plan" : usageLabel}
          </p>
        </div>
      </header>

      {!keysReady ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Finish setup to generate videos.</p>
          <p className="mt-1 text-muted-foreground">
            You still need to add your{" "}
            {!keyStatus.llm && !keyStatus.pexels
              ? "LLM and Pexels keys"
              : !keyStatus.llm
                ? "LLM key"
                : "Pexels key"}
            .{" "}
            <Link className="font-medium underline underline-offset-4" href="/settings/video-keys">
              Add keys →
            </Link>
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New video</CardTitle>
        </CardHeader>
        <CardContent>
          <GenerateVideoForm accounts={accounts} />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Recent renders</h2>
        {jobs.length === 0 ? (
          <EmptyState
            icon="spark"
            title="No renders yet"
            description="Your generated videos will appear here with live progress."
          />
        ) : (
          <JobList jobs={jobs} />
        )}
      </section>
    </div>
  );
}

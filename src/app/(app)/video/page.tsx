import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { mptConfigured, byoKeysConfigured, videoPublishEnabled, referenceVideoEnabled } from "@/lib/env";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { tierFor } from "@/lib/billing/tiers";
import { getUsageSnapshot } from "@/lib/billing/usage";
import { supabaseService } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/types";
import type { VideoJobStatus } from "@/lib/video/jobs";
import { listAvatars } from "@/lib/video/avatars";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GenerateVideoForm } from "./generate-form";
import { GenerateUgcForm, type UgcAvatarOption } from "./ugc-form";
import { JobList, type JobListItem } from "./job-list";
import { VideoModeTabs } from "./video-mode-tabs";

export const dynamic = "force-dynamic";

function paramString(params: Json, key: string, fallback: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

export default async function VideoPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const refEnabled = referenceVideoEnabled();
  // The UGC tab lives on this same page (?mode=ugc) and only when the
  // reference-video feature is on — otherwise we ignore the param and stay on
  // the topic surface so the tab never points anywhere dead.
  const params = await searchParams;
  const mode: "topic" | "ugc" = refEnabled && params.mode === "ugc" ? "ugc" : "topic";

  const mpt = mptConfigured();
  const byo = byoKeysConfigured();
  // UGC mode rides the reference-video pipeline (Higgsfield), not MPT — so it
  // only needs credential encryption, not the MPT render worker. Topic mode is
  // unchanged: it still requires both. Either way, without `byo` nothing works.
  const gateOk = mode === "ugc" ? byo : mpt && byo;
  if (!gateOk) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Video</h1>
          <p className="text-sm text-muted-foreground">Generate short videos from a subject.</p>
        </header>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Video generation isn&apos;t available on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            {mode !== "ugc" && !mpt && (
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
    .select("id, status, progress, params, failure_reason, created_at, post_id")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: false })
    .limit(50);

  // This is the "from a topic" (MPT) surface — exclude reference-image renders,
  // which live on their own "Animate a photo" page so the two don't intermix.
  const jobs: JobListItem[] = (rows ?? [])
    .filter((r) => paramString(r.params, "kind", "") !== "reference_image")
    .map((r) => ({
      id: r.id,
      status: r.status as VideoJobStatus,
      progress: r.progress ?? 0,
      subject: paramString(r.params, "video_subject", "Untitled video"),
      aspect: paramString(r.params, "video_aspect", "9:16"),
      failureReason: r.failure_reason ?? null,
      createdAt: r.created_at,
      postId: r.post_id,
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

  // UGC mode needs the workspace's saved avatars to populate the picker. Fetch
  // only when on that tab (service-role read — RLS allows member SELECT, but the
  // helper is service-role; auth/workspace gating happened above).
  const avatars: UgcAvatarOption[] =
    mode === "ugc"
      ? (await listAvatars(ws.id)).map((a) => ({ id: a.id, name: a.name, isPrimary: a.isPrimary }))
      : [];
  const ugcKeyReady = keyStatus.higgsfield_video;

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

      <VideoModeTabs active={mode} referenceEnabled={refEnabled} />

      {mode === "topic" && !keysReady ? (
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

      {mode === "ugc" && !ugcKeyReady ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Finish setup to generate UGC videos.</p>
          <p className="mt-1 text-muted-foreground">
            You still need to add your Higgsfield key.{" "}
            <Link
              className="font-medium underline underline-offset-4"
              href="/settings/reference-video"
            >
              Add key →
            </Link>
          </p>
        </div>
      ) : null}

      {mode === "ugc" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New UGC video</CardTitle>
            <CardDescription>
              Pick a saved avatar, type a script, and we&apos;ll render a talking clip via Higgsfield.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {avatars.length === 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                <p className="font-medium">No avatars yet.</p>
                <p className="mt-1 text-muted-foreground">
                  Save an avatar first, then come back to render a UGC video from it.{" "}
                  <Link
                    className="font-medium underline underline-offset-4"
                    href="/settings/avatars"
                  >
                    Add an avatar →
                  </Link>
                </p>
              </div>
            ) : (
              <GenerateUgcForm avatars={avatars} accounts={accounts} />
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New video</CardTitle>
          </CardHeader>
          <CardContent>
            <GenerateVideoForm accounts={accounts} />
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent renders</h2>
          <Link
            href="/video/library"
            className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground"
          >
            Video library →
          </Link>
        </div>
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

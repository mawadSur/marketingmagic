// Reference-image video (bet ④ · Capability A) · generate page.
//
// Generate UI for the NEW likeness/image-conditioned video path (distinct from
// the MPT Pexels-stitch pipeline): upload a reference photo, prompt + aspect +
// duration, a REQUIRED consent checkbox → starts a fal.ai image-to-video render.
// Gated behind REFERENCE_VIDEO_ENABLED: when off, renders a "not enabled" notice
// and no form is shown, so nothing is live. Discoverable from /video via the
// shared mode tabs.

import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { referenceVideoEnabled, byoKeysConfigured } from "@/lib/env";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { getUsageSnapshot } from "@/lib/billing/usage";
import { tierFor } from "@/lib/billing/tiers";
import type { Json } from "@/lib/db/types";
import type { VideoJobStatus } from "@/lib/video/jobs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { JobList, type JobListItem } from "../../video/job-list";
import { VideoModeTabs } from "../../video/video-mode-tabs";
import { ReferenceImageUploadForm } from "./upload-form";
import {
  FalVideoKeyForm,
  FalVideoKeyStatus,
  DidVideoKeyForm,
  DidVideoKeyStatus,
} from "./key-form";

export const dynamic = "force-dynamic";

function paramString(params: Json, key: string, fallback: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

export default async function ReferenceVideoPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const enabled = referenceVideoEnabled();

  if (!enabled) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header />
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">This feature isn&apos;t enabled yet.</p>
          <p className="mt-1 text-muted-foreground">
            Reference-image video is gated. It lights up once an operator sets{" "}
            <code>REFERENCE_VIDEO_ENABLED</code>.
          </p>
        </div>
      </div>
    );
  }

  // Presence-only key status, monthly render usage, and this workspace's recent
  // reference-image renders (the "Animate a photo" path only — topic renders
  // live on /video). Jobs read through the user-scoped client so RLS governs.
  const byo = byoKeysConfigured();
  const supabase = await supabaseServer();
  const [status, usage, jobRows] = await Promise.all([
    byo
      ? getWorkspaceKeyStatus(ws.id)
      : Promise.resolve({ llm: false, pexels: false, fal_video: false, did_video: false }),
    getUsageSnapshot(ws.id),
    supabase
      .from("video_jobs")
      .select("id, status, progress, params, failure_reason, created_at, post_id")
      .eq("workspace_id", ws.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const limit = tierFor(ws.plan).limits.videosPerMonth;
  const usageLabel = limit === -1 ? `${usage.videosGenerated} / ∞` : `${usage.videosGenerated} / ${limit}`;

  const jobs: JobListItem[] = (jobRows.data ?? [])
    .filter((r) => paramString(r.params, "kind", "") === "reference_image")
    .map((r) => ({
      id: r.id,
      status: r.status as VideoJobStatus,
      progress: r.progress ?? 0,
      subject: paramString(r.params, "prompt", paramString(r.params, "video_subject", "Animated photo")),
      aspect: paramString(r.params, "aspect", "9:16"),
      failureReason: r.failure_reason ?? null,
      createdAt: r.created_at,
      postId: r.post_id,
    }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header />
        <div className="text-right text-xs text-muted-foreground">
          <p className="uppercase tracking-wide">Renders this month</p>
          <p className={"text-sm font-medium " + (limit === 0 ? "text-destructive" : "text-foreground")}>
            {limit === 0 ? "Not included on your plan" : usageLabel}
          </p>
        </div>
      </div>

      <VideoModeTabs active="reference" referenceEnabled />

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">fal video key</CardTitle>
            <CardDescription>
              For &ldquo;Animate a photo&rdquo;. Bring your own fal.ai key — image-to-video. Stored encrypted.
            </CardDescription>
          </div>
          {byo ? <FalVideoKeyStatus configured={status.fal_video} /> : null}
        </CardHeader>
        <CardContent>
          {byo ? (
            <FalVideoKeyForm configured={status.fal_video} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Credential encryption isn&apos;t configured on this deployment (set{" "}
              <code>BYO_ENCRYPTION_KEY</code>).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">D-ID key</CardTitle>
            <CardDescription>
              For &ldquo;Make it talk&rdquo;. Bring your own D-ID key — talking avatar from a photo + script. Stored encrypted.
            </CardDescription>
          </div>
          {byo ? <DidVideoKeyStatus configured={status.did_video} /> : null}
        </CardHeader>
        <CardContent>
          {byo ? (
            <DidVideoKeyForm configured={status.did_video} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Credential encryption isn&apos;t configured on this deployment (set{" "}
              <code>BYO_ENCRYPTION_KEY</code>).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate</CardTitle>
          <CardDescription>
            Animate a photo (motion prompt) or make it talk (script). The render lands in your approval queue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReferenceImageUploadForm
            falConfigured={status.fal_video}
            didConfigured={status.did_video}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Recent renders</h2>
        {jobs.length === 0 ? (
          <EmptyState
            icon="spark"
            title="No renders yet"
            description="Animate a photo above and your renders will appear here with live progress."
          />
        ) : (
          <JobList jobs={jobs} />
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Reference-image video</h1>
      <p className="text-sm text-muted-foreground">
        Upload a photo of yourself and generate video using it as a likeness reference.
      </p>
    </header>
  );
}

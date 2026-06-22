import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { userVideoUploadEnabled, videoPublishEnabled } from "@/lib/env";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/empty-state";
import type { Json } from "@/lib/db/types";
import type { VideoJobStatus } from "@/lib/video/jobs";
import { ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import {
  SOURCE_VIDEO_BUCKET,
  type TranscriptSegment,
  type TranscriptSegmentRow,
} from "@/lib/video/uploads/types";
import { JobList, type JobListItem } from "../../job-list";
import { ClipEditor } from "./clip-editor";
import { MarketClipButton } from "./market-clip-button";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL = 60 * 60; // 1h — enough to watch + mark a long source.

function paramString(params: Json | null, key: string, fallback: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

// Narrow the persisted jsonb segments array into the domain TranscriptSegment[].
// Defensive: skips malformed entries rather than trusting the column shape.
function toSegments(raw: Json | null): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const r = entry as Partial<TranscriptSegmentRow>;
      if (typeof r.start_ms === "number" && typeof r.end_ms === "number" && typeof r.text === "string") {
        out.push({ startMs: r.start_ms, endMs: r.end_ms, text: r.text });
      }
    }
  }
  return out;
}

function aspectGuess(width: number | null, height: number | null): "9:16" | "16:9" | "1:1" {
  if (!width || !height || width <= 0 || height <= 0) return "9:16";
  const r = width / height;
  if (r > 1.2) return "16:9";
  if (r < 0.85) return "9:16";
  return "1:1";
}

export default async function UploadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Feature flag — off by default; the whole surface stays dark.
  if (!userVideoUploadEnabled()) notFound();

  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  // uploaded_videos / video_transcripts and the additive video_jobs clip columns
  // aren't in the generated Database type until it's regenerated for migration
  // 068 (shared foundation file outside this slice). Go through a loosely-typed
  // `.from()` — same convention as the sibling uploads/* modules. See return note.
  const db = supabase as unknown as {
    from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // Source video — RLS scopes to the workspace, so a stray id from another
  // workspace simply returns nothing → 404.
  const { data: video } = (await db
    .from("uploaded_videos")
    .select("id, storage_path, original_filename, status, failure_reason, duration_seconds, width, height")
    .eq("id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle()) as {
    data: {
      id: string;
      storage_path: string;
      original_filename: string | null;
      status: string;
      failure_reason: string | null;
      duration_seconds: number | null;
      width: number | null;
      height: number | null;
    } | null;
  };

  if (!video) notFound();

  const title = video.original_filename || "Uploaded video";

  // Failed/still-uploading sources can't be edited yet — show status instead.
  if (video.status !== "ready") {
    return (
      <Shell title={title}>
        {video.status === "failed" ? (
          <Notice variant="warning" title="This upload failed.">
            {video.failure_reason || "We couldn't process this video. Try uploading it again."}
          </Notice>
        ) : (
          <Notice variant="info" title="Still processing…">
            We&apos;re preparing this video. Refresh in a moment to start clipping.
          </Notice>
        )}
      </Shell>
    );
  }

  // Signed GET URL for the private source bucket so the browser can play it.
  const { data: signed } = await supabaseService()
    .storage.from(SOURCE_VIDEO_BUCKET)
    .createSignedUrl(video.storage_path, SIGNED_URL_TTL);

  if (!signed?.signedUrl) {
    return (
      <Shell title={title}>
        <Notice variant="warning" title="Couldn't load this video.">
          The source file is missing or unreadable. Try uploading it again.
        </Notice>
      </Shell>
    );
  }

  // Transcript (slice-B writes it; we only read). One row per source video.
  const { data: transcriptRow } = (await db
    .from("video_transcripts")
    .select("segments")
    .eq("uploaded_video_id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle()) as { data: { segments: Json } | null };
  const segments = toSegments(transcriptRow?.segments ?? null);

  // Clip jobs cut from THIS source (params.kind='user_clip', filtered by the
  // additive uploaded_video_id column). Reuses the shared JobList.
  const { data: jobRows } = (await db
    .from("video_jobs")
    .select("id, status, progress, params, failure_reason, created_at, post_id, clip_label")
    .eq("workspace_id", ws.id)
    .eq("uploaded_video_id", id)
    .order("created_at", { ascending: false })
    .limit(50)) as {
    data: Array<{
      id: string;
      status: string;
      progress: number | null;
      params: Json;
      failure_reason: string | null;
      created_at: string;
      post_id: string | null;
      clip_label: string | null;
    }> | null;
  };

  const jobs: JobListItem[] = (jobRows ?? []).map((r) => ({
    id: r.id,
    status: r.status as VideoJobStatus,
    progress: r.progress ?? 0,
    subject: r.clip_label || paramString(r.params, "label", "Clip"),
    aspect: paramString(r.params, "aspect", "9:16"),
    failureReason: r.failure_reason ?? null,
    createdAt: r.created_at,
    postId: r.post_id,
  }));

  // Ready clips can be marketed straight from the editor. The deployment's
  // video-capable channels = enabled registry channels ∩ VIDEO_PUBLISH_CHANNELS.
  const videoChannels: ChannelId[] = ENABLED_CHANNELS.filter((ch) => videoPublishEnabled(ch));
  const readyClips = (jobRows ?? []).filter((r) => r.status === "ready");

  const durationMs =
    video.duration_seconds && video.duration_seconds > 0
      ? Math.round(video.duration_seconds * 1000)
      : 0;

  return (
    <Shell title={title}>
      <ClipEditor
        uploadedVideoId={video.id}
        sourceUrl={signed.signedUrl}
        durationMs={durationMs}
        aspectGuess={aspectGuess(video.width, video.height)}
        segments={segments}
        transcriptPending={segments.length === 0}
      />

      {jobs.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Clips from this video</h2>
          <JobList jobs={jobs} />
          {/* "Market this clip" entrypoint (slice F) — for each finished clip,
              draft native per-channel posts (pending_approval) straight from the
              editor. Each lands in /queue with the video attached. */}
          {readyClips.length > 0 && (
            <div className="space-y-3 border-t border-border pt-3">
              {readyClips.map((r) => (
                <div key={r.id} className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground capitalize">
                    {r.clip_label || paramString(r.params, "label", "Clip")}
                  </p>
                  <MarketClipButton jobId={r.id} videoChannels={videoChannels} />
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Drafted posts land in the{" "}
            <Link href="/queue" className="font-medium text-primary underline-offset-4 hover:underline">
              queue →
            </Link>{" "}
            for review before they publish.
          </p>
        </section>
      ) : (
        <EmptyState
          icon="spark"
          title="No clips yet"
          description="Mark a range above and press “Create clips” — they'll show up here as they render."
        />
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <Link
          href="/video?mode=upload"
          className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground"
        >
          ← Back to uploads
        </Link>
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">
          Mark the moments you want, label each clip, and we&apos;ll cut them for you.
        </p>
      </header>
      {children}
    </div>
  );
}

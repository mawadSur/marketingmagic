import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, mptConfigured, referenceVideoEnabled } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  getTask,
  downloadVideo,
  deleteTask,
  fileNameFromVideoPath,
  MPT_STATE_COMPLETE,
  MPT_STATE_FAILED,
} from "@/lib/video/mpt-client";
import {
  listProcessing,
  updateProgress,
  markReady,
  markFailed,
  type VideoJobRow,
} from "@/lib/video/jobs";
import { getWorkspaceKeys } from "@/lib/video/byo-keys";
import { getReferenceVideoProvider } from "@/lib/video/reference/stub-provider";
import type { ReferenceVideoCapability } from "@/lib/video/reference/provider";
import type { PostMediaItem } from "@/lib/social/dispatch";

// Vercel/GitHub-Actions Cron — POST every 1-2 minutes. Auth via Bearer
// CRON_SECRET (mirrors post-scheduled). For each `processing` video_jobs row:
//   - poll MPT for state/progress
//   - on COMPLETE(1): stream the mp4 from MPT into the post-media-video
//     bucket, create/update a DRAFT post with a {kind:"video"} media item,
//     mark the job ready, then free the worker's disk (deleteTask).
//   - on FAILED(-1): mark the job failed with MPT's reason.
//
// MPT→Supabase is streamed (res.body piped to storage.upload) so we never
// buffer a 200MB file into the function's memory.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "post-media-video";
const BATCH = 25;
// Safety net: a render that never reaches a terminal MPT state (worker crash,
// MPT unreachable, task GC'd) would otherwise stay `processing` forever. After
// this long we fail it so the user sees an error and can retry. MPT itself now
// fails closed on stage errors, so this only catches lost/unreachable tasks.
const MAX_PROCESSING_MS = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Cleanly no-op when NEITHER pipeline is wired up rather than throwing. The
  // reference-image video path (bet ④) runs without MPT, so we only early-return
  // when MPT is unconfigured AND the reference path is also disabled — otherwise
  // a reference-only deployment (no MPT) must still drain its jobs.
  if (!mptConfigured() && !referenceVideoEnabled()) {
    return NextResponse.json({ skipped: "no-video-pipeline-configured", checked: 0, results: [] });
  }

  const svc = supabaseService();
  const jobs = await listProcessing(BATCH);

  const results: Array<{
    id: string;
    status: "ready" | "processing" | "failed" | "error";
    reason?: string;
  }> = [];

  for (const job of jobs) {
    try {
      // Reference-image video (bet ④) — these jobs are NOT MPT tasks. Route them
      // to the fal-adapter poller and skip the entire MPT branch below. The MPT
      // path stays exactly as-is for params.kind !== "reference_image".
      if (jobKind(job) === "reference_image") {
        const r = await processReferenceJob(svc, job);
        results.push(r);
        continue;
      }

      // ── MPT path (unchanged) ──────────────────────────────────────────────
      if (!job.mpt_task_id) {
        await markFailed(job.id, "processing job has no mpt_task_id");
        results.push({ id: job.id, status: "failed", reason: "missing mpt_task_id" });
        continue;
      }

      // Stale guard — fail renders that never reached a terminal state.
      if (Date.now() - new Date(job.created_at).getTime() > MAX_PROCESSING_MS) {
        await markFailed(job.id, "render timed out (no completion from the render worker)");
        results.push({ id: job.id, status: "failed", reason: "timed out" });
        continue;
      }

      const task = await getTask(job.mpt_task_id);
      const { state, progress, videos } = task.data;

      // Keep progress fresh on every tick (best-effort).
      if (typeof progress === "number") {
        await updateProgress(job.id, progress).catch(() => {});
      }

      if (state === MPT_STATE_FAILED) {
        await markFailed(job.id, "MPT reported render failed (state -1)");
        results.push({ id: job.id, status: "failed", reason: "mpt failed" });
        continue;
      }

      if (state !== MPT_STATE_COMPLETE) {
        // Still rendering (PROCESSING or any non-terminal state).
        results.push({ id: job.id, status: "processing" });
        continue;
      }

      // COMPLETE — pull the finished mp4 and finalise the job.
      const firstVideo = videos?.[0];
      if (!firstVideo) {
        await markFailed(job.id, "MPT complete but returned no videos[]");
        results.push({ id: job.id, status: "failed", reason: "no videos" });
        continue;
      }

      const fileName = fileNameFromVideoPath(firstVideo);
      const storagePath = `${job.workspace_id}/${job.id}/final.mp4`;

      // Stream MPT → Supabase Storage. supabase-js upload accepts the raw
      // ReadableStream body; falls back to an ArrayBuffer if body is null.
      const dl = await downloadVideo(job.mpt_task_id, fileName);
      const uploadBody: ReadableStream<Uint8Array> | ArrayBuffer = dl.body
        ? (dl.body as ReadableStream<Uint8Array>)
        : await dl.arrayBuffer();

      const { error: upErr } = await svc.storage.from(BUCKET).upload(storagePath, uploadBody, {
        contentType: "video/mp4",
        upsert: true,
        // `duplex: "half"` is required by undici/Node when the body is a
        // stream. supabase-js forwards unknown opts to fetch; cast since the
        // option isn't in its typed surface.
        ...({ duplex: "half" } as Record<string, unknown>),
      });
      if (upErr) {
        await markFailed(job.id, `storage upload failed: ${upErr.message}`);
        results.push({ id: job.id, status: "failed", reason: "upload failed" });
        continue;
      }

      // Attach the video to a DRAFT post when the job has a destination
      // channel; otherwise leave post_id null for the P4 UI to wire up.
      const postId = await attachDraftPost(svc, job, storagePath);

      await markReady(job.id, storagePath, postId);

      // Free the worker's disk. Best-effort — a cleanup failure must not
      // re-fail an otherwise-ready job.
      await deleteTask(job.mpt_task_id).catch(() => {});

      results.push({ id: job.id, status: "ready" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      // Transport hiccup (e.g. MPT briefly unreachable) — record but don't
      // hard-fail the job; the next tick retries. We only mark `failed` on
      // explicit MPT FAILED state above.
      results.push({ id: job.id, status: "error", reason });
    }
  }

  return NextResponse.json({ checked: jobs.length, results, at: new Date().toISOString() });
}

// Read the params.kind discriminator off a job row. MPT jobs predate the
// discriminator (params has no `kind`), so anything that isn't explicitly
// "reference_image" falls through to the unchanged MPT branch.
function jobKind(job: VideoJobRow): string {
  const p = job.params;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const k = (p as Record<string, unknown>).kind;
    if (typeof k === "string") return k;
  }
  return "mpt";
}

// Read params.capability off a reference job to pick the adapter (fal vs D-ID).
// Defaults to "animate" (fal) — legacy reference jobs predate the discriminator
// (params.capability absent / provider "fal_video"), so they keep polling fal.
function jobCapability(job: VideoJobRow): ReferenceVideoCapability {
  const p = job.params;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const rec = p as Record<string, unknown>;
    if (rec.capability === "present" || rec.provider === "did_video") return "present";
  }
  return "animate";
}

// Reference-image video (bet ④) — poll one reference job and finalise it. Mirrors
// the MPT finalize: stale-guard → poll the provider → on ready pull the mp4 into
// the post-media-video bucket and attach a DRAFT post → markReady; on failed
// markFailed. The adapter (fal vs D-ID) AND the matching BYO key (fal_video vs
// did_video) are chosen PER JOB from params.capability/params.provider — so the
// same cron drains both Capability A ("animate") and Capability B ("present")
// jobs. The key is the workspace's own BYO secret (service-role decrypt).
async function processReferenceJob(
  svc: ReturnType<typeof supabaseService>,
  job: VideoJobRow,
): Promise<{ id: string; status: "ready" | "processing" | "failed" | "error"; reason?: string }> {
  // mpt_task_id holds the provider request id for reference jobs (set by
  // markProcessing). Without it there's nothing to poll.
  if (!job.mpt_task_id) {
    await markFailed(job.id, "reference job has no provider request id");
    return { id: job.id, status: "failed", reason: "missing request id" };
  }

  // Same stale-guard as the MPT path — fail renders that never terminate.
  if (Date.now() - new Date(job.created_at).getTime() > MAX_PROCESSING_MS) {
    await markFailed(job.id, "reference render timed out (no completion from the provider)");
    return { id: job.id, status: "failed", reason: "timed out" };
  }

  // Which capability/adapter this job is. Defaults to "animate" (fal) so legacy
  // reference jobs written before params.capability existed still poll fal.
  const capability = jobCapability(job);
  const isPresent = capability === "present";

  // The provider needs the workspace's decrypted key for THIS capability:
  //   "animate" → fal_video    "present" → did_video
  const keys = await getWorkspaceKeys(job.workspace_id);
  const apiKey = isPresent ? keys.did_video?.api_key : keys.fal_video?.api_key;
  if (!apiKey) {
    const label = isPresent ? "D-ID" : "fal video";
    await markFailed(job.id, `no ${label} key for workspace (key removed mid-render?)`);
    return { id: job.id, status: "failed", reason: `missing ${isPresent ? "did" : "fal"} key` };
  }

  const provider = getReferenceVideoProvider(capability);
  const poll = await provider.poll(job.mpt_task_id, apiKey);

  if (typeof poll.progress === "number") {
    await updateProgress(job.id, poll.progress).catch(() => {});
  }

  if (poll.status === "failed") {
    await markFailed(job.id, poll.failureReason ?? "provider reported render failed");
    return { id: job.id, status: "failed", reason: poll.failureReason ?? "provider failed" };
  }

  if (poll.status !== "ready" || !poll.videoUrl) {
    // Still rendering — try again next tick.
    return { id: job.id, status: "processing" };
  }

  // READY — pull the mp4 immediately (CDN URL can expire) and own the asset.
  const { bytes, contentType } = await provider.fetchBytes(poll.videoUrl, apiKey);
  const storagePath = `${job.workspace_id}/${job.id}/final.mp4`;

  const { error: upErr } = await svc.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: contentType || "video/mp4",
    upsert: true,
  });
  if (upErr) {
    await markFailed(job.id, `storage upload failed: ${upErr.message}`);
    return { id: job.id, status: "failed", reason: "upload failed" };
  }

  // Reuse the same draft-post attachment as the MPT path — the post lands as
  // pending_approval (already the case in attachDraftPost).
  const postId = await attachDraftPost(svc, job, storagePath);
  await markReady(job.id, storagePath, postId);
  return { id: job.id, status: "ready" };
}

// Create or update a DRAFT post carrying the rendered video as a media item.
// Returns the post id, or null when the job has no destination channel (the
// posts table requires a non-null social_account_id + channel, so we can't
// create one without a target — that's deferred to the P4 UI).
async function attachDraftPost(
  svc: ReturnType<typeof supabaseService>,
  job: VideoJobRow,
  storagePath: string,
): Promise<string | null> {
  if (!job.social_account_id) return null;

  const { data: account } = await svc
    .from("social_accounts")
    .select("channel")
    .eq("id", job.social_account_id)
    .maybeSingle();
  if (!account) return null;

  const mediaItem: PostMediaItem = {
    kind: "video",
    storage_path: storagePath,
    content_type: "video/mp4",
  };

  // Seed the caption from the render subject so the post isn't empty; the user
  // edits it before approving. The post lands as `pending_approval` so it shows
  // up in the queue's approval list (a bare `draft` is surfaced nowhere and the
  // approve action rejects it — that left rendered videos orphaned).
  const params = job.params;
  const caption =
    params && typeof params === "object" && !Array.isArray(params)
      ? String((params as Record<string, unknown>).video_subject ?? "")
      : "";

  // Update the existing draft if the job already minted one; else insert.
  if (job.post_id) {
    await svc
      .from("posts")
      .update({ media: [mediaItem] as unknown as never })
      .eq("id", job.post_id);
    return job.post_id;
  }

  const { data: inserted, error } = await svc
    .from("posts")
    .insert({
      workspace_id: job.workspace_id,
      social_account_id: job.social_account_id,
      channel: account.channel,
      text: caption,
      status: "pending_approval",
      media: [mediaItem] as unknown as never,
    })
    .select("id")
    .single();
  if (error || !inserted) return null;
  return inserted.id;
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

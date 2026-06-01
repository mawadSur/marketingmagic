import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, mptConfigured } from "@/lib/env";
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
  // Cleanly no-op when MPT isn't wired up rather than throwing.
  if (!mptConfigured()) {
    return NextResponse.json({ skipped: "mpt-not-configured", checked: 0, results: [] });
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

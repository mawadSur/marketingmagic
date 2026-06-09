// Video analysis runner (Hormozi slice 2) — load → analyze → persist.
//
// `analyzePostVideo(postId)` is the on-demand v1 trigger. It:
//   1. Loads the post (service-role) and finds its rendered video media item.
//   2. Downloads the mp4 bytes from the post-media-video bucket (we OWN these —
//      no TTL — confirmed via poll-video-jobs + dispatch.loadMedia).
//   3. Reads the workspace's BYO analysis key + chosen model (service-role
//      decrypt — the key NEVER leaves the server, never logged).
//   4. Calls analyzeVideo() (BYO-key + user-chosen model dispatch).
//   5. UPSERTs the structured breakdown into video_analysis (one row per post).
//
// SCOPE (v1): OUR-RENDERED videos only — we have those bytes. Organic videos
// posted outside our pipeline are deferred (see the TODO below).
//
// No cron yet — this is on-demand. Never logs the key or the bytes.

import { supabaseService } from "@/lib/supabase/service";
import { getWorkspaceKeys } from "@/lib/video/byo-keys";
import { analyzeVideo, type VideoAnalysis, VideoAnalysisError } from "./index";

const BUCKET = "post-media-video";

// The media-item shape we read off posts.media (mirrors dispatch.PostMediaItem,
// narrowed to the fields we need). Kept local so this module doesn't depend on
// the social dispatch surface.
interface PostMediaItem {
  kind?: string;
  storage_path?: string;
  content_type?: string;
}

export interface AnalyzePostVideoResult {
  analysisId: string;
  analysis: VideoAnalysis;
  provider: string;
  model: string;
}

// Analyse the rendered video on `postId` for `workspaceId` and persist the
// breakdown. Throws VideoAnalysisError with a user-safe message on any failure
// (no key, no video, provider/parse error). The caller (server action) is
// responsible for auth — this trusts the workspaceId it's handed.
export async function analyzePostVideo(
  workspaceId: string,
  postId: string,
): Promise<AnalyzePostVideoResult> {
  const svc = supabaseService();

  // 1. Load the post and confirm it belongs to the workspace.
  const { data: post, error: postErr } = await svc
    .from("posts")
    .select("id, workspace_id, media")
    .eq("id", postId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (postErr) {
    throw new VideoAnalysisError(`Could not load the post: ${postErr.message}`);
  }
  if (!post) {
    throw new VideoAnalysisError("Post not found in this workspace.");
  }

  // 2. Find the rendered video media item. v1 = our-rendered videos only (bytes
  // we own in post-media-video). A post with only an external/organic video has
  // no such item → unsupported for now.
  //
  // TODO: organic videos posted outside our pipeline — we have only an
  // external_id, not bytes. Fetch the platform CDN url and pass it as
  // analyzeVideo({ videoUrl }) once the byte-source decision lands.
  const media = (Array.isArray(post.media) ? post.media : []) as PostMediaItem[];
  const videoItem = media.find((m) => m.kind === "video" && m.storage_path);
  if (!videoItem?.storage_path) {
    throw new VideoAnalysisError(
      "This post has no rendered video to analyse (v1 supports our-rendered videos only).",
    );
  }

  // 3. Read the workspace's BYO analysis key + chosen model. Service-role
  // decrypt — the plaintext key stays on the server and is never logged.
  const keys = await getWorkspaceKeys(workspaceId);
  const analysisKey = keys.analysis;
  if (!analysisKey?.api_key || !analysisKey.model) {
    throw new VideoAnalysisError(
      "No analysis key configured. Add your analysis provider key + model in Video keys.",
    );
  }

  // 4. Download the mp4 bytes (we own them; no TTL) — same idiom as
  // dispatch.loadMedia.
  const { data: blob, error: dlErr } = await svc.storage
    .from(BUCKET)
    .download(videoItem.storage_path);
  if (dlErr || !blob) {
    throw new VideoAnalysisError(`Could not download the video: ${dlErr?.message ?? "no data"}`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // 5. Analyse (BYO-key + user-chosen model dispatch).
  const analysis = await analyzeVideo({
    bytes,
    contentType: videoItem.content_type || "video/mp4",
    apiKey: analysisKey.api_key,
    model: analysisKey.model,
  });

  // 6. UPSERT the breakdown (one row per post; a re-run overwrites). `provider`
  // + `model` record which BYO backend produced this row. `raw` is the verbatim
  // provider response for re-parsing without re-charging.
  const { data: upserted, error: upErr } = await svc
    .from("video_analysis")
    .upsert(
      {
        workspace_id: workspaceId,
        post_id: postId,
        media_storage_path: videoItem.storage_path,
        transcript: analysis.transcript,
        visual_breakdown: analysis.visual_breakdown as unknown as never,
        hook_spoken: analysis.hook_spoken,
        hook_visual: analysis.hook_visual,
        provider: analysisKey.provider,
        model: analysisKey.model,
        analyzed_at: new Date().toISOString(),
        raw: analysis.raw as unknown as never,
      },
      { onConflict: "post_id" },
    )
    .select("id")
    .single();
  if (upErr || !upserted) {
    throw new VideoAnalysisError(`Could not save the analysis: ${upErr?.message ?? "no row"}`);
  }

  return {
    analysisId: upserted.id,
    analysis,
    provider: analysisKey.provider,
    model: analysisKey.model,
  };
}

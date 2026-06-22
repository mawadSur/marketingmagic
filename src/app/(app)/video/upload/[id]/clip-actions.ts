"use server";

// Clip-editor server action (slice E).
//
// Validates the user's marked clip ranges (ClipSpec[]) at the boundary, then
// hands the whole batch to slice-D's clip orchestrator. The action OWNS only
// validation + auth/flag gating + revalidation; it does NOT talk to MPT or the
// DB directly — that's slice-D's `startClipJobs`.
//
// Hard-gated by userVideoUploadEnabled() so the feature stays dark until the
// flag is flipped, mirroring the reference-video upload action.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userVideoUploadEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import type { Json } from "@/lib/db/types";
import type { ClipSpec, TranscriptSegment, TranscriptSegmentRow } from "@/lib/video/uploads/types";
// Slice-D entrypoint. Cuts each ClipSpec out of the source video: signs the
// source GET URL, builds per-clip subtitlesSrt from transcriptSegments, creates
// the video_jobs rows (params.kind='user_clip' + clip cols) and POSTs
// /api/v1/clip. Throws ClipJobError on a render/setup failure; raises
// QuotaExceededError when the workspace is over its video cap.
import { startClipJobs } from "@/lib/video/uploads/clip-orchestrator";
import { QuotaExceededError } from "@/lib/billing/limits";

// Re-load the source transcript server-side rather than trusting client-sent
// caption text — slice-D slices + re-bases these per clip for burn-in.
function rowsToSegments(raw: Json | null | undefined): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const e of raw) {
    if (e && typeof e === "object" && !Array.isArray(e)) {
      const r = e as Partial<TranscriptSegmentRow>;
      if (typeof r.start_ms === "number" && typeof r.end_ms === "number" && typeof r.text === "string") {
        out.push({ startMs: r.start_ms, endMs: r.end_ms, text: r.text });
      }
    }
  }
  return out;
}

export interface CreateClipsState {
  error: string | null;
  success: string | null;
  // Set when the failure is a plan/quota cap so the form can deep-link billing.
  quota: boolean;
}

// Mirrors ClipSpec but validated from the wire. label is re-slugged client-side
// (clip-math.slugifyLabel) before submit, so we only defend the shape + ranges.
const ClipSpecSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(64)
    // Defence-in-depth: only fs-safe slug chars reach the MPT output filename.
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Clip name must be a lowercase slug."),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  burnCaptions: z.boolean(),
});

const PayloadSchema = z.object({
  uploadedVideoId: z.string().uuid(),
  aspect: z.enum(["9:16", "16:9", "1:1"]).optional(),
  clips: z.array(ClipSpecSchema).min(1).max(20),
});

export async function createClipsAction(
  _prev: CreateClipsState,
  formData: FormData,
): Promise<CreateClipsState> {
  if (!userVideoUploadEnabled()) {
    return { error: "Video upload isn't enabled on this deployment yet.", success: null, quota: false };
  }

  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  // The client serialises the editor state into a single hidden `payload` JSON
  // field — cleaner than N indexed form fields for a dynamic clip list.
  const raw = formData.get("payload");
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: "Nothing to cut — mark at least one clip first.", success: null, quota: false };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: "Couldn't read the clip selection. Please try again.", success: null, quota: false };
  }

  const parsed = PayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Invalid clip selection.";
    return { error: first, success: null, quota: false };
  }

  // Reject zero/negative-length ranges that survive shape validation.
  const bad = parsed.data.clips.find((c) => c.endMs <= c.startMs);
  if (bad) {
    return { error: `Clip "${bad.label}" has an empty range.`, success: null, quota: false };
  }

  const specs: ClipSpec[] = parsed.data.clips;

  // Pull the source transcript so slice-D can slice per-clip captions for any
  // clip with burnCaptions on. RLS scopes to the workspace; absent → no burn.
  const wantsCaptions = specs.some((c) => c.burnCaptions);
  let transcriptSegments: TranscriptSegment[] = [];
  if (wantsCaptions) {
    const supabase = await supabaseServer();
    // video_transcripts isn't in the generated Database type until it's
    // regenerated for migration 068 (shared foundation file) — loose `.from()`.
    const db = supabase as unknown as {
      from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const { data: t } = (await db
      .from("video_transcripts")
      .select("segments")
      .eq("uploaded_video_id", parsed.data.uploadedVideoId)
      .eq("workspace_id", ws.id)
      .maybeSingle()) as { data: { segments: Json } | null };
    transcriptSegments = rowsToSegments(t?.segments ?? null);
  }

  try {
    const result = await startClipJobs(ws.id, parsed.data.uploadedVideoId, {
      clips: specs,
      aspect: parsed.data.aspect,
      transcriptSegments,
    });
    revalidatePath(`/video/upload/${parsed.data.uploadedVideoId}`);
    const n = result?.jobs?.length ?? specs.length;
    return {
      error: null,
      success: `Cutting ${n} clip${n === 1 ? "" : "s"} — they'll appear below as they finish.`,
      quota: false,
    };
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return {
        error: "You've hit your video limit for this month. Upgrade to cut more clips.",
        success: null,
        quota: true,
      };
    }
    const msg = err instanceof Error ? err.message : "Couldn't start the clip render.";
    return { error: msg, success: null, quota: false };
  }
}

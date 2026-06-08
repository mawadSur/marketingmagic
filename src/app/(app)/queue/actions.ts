"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { defaultImageProvider } from "@/lib/images";
import { loadBrandStyle } from "@/lib/brand/load";
import { applyBrandStyleToPrompt } from "@/lib/brand/style";
import { maxCharsFor } from "@/lib/channels/registry";
import { applyHashtagsToText, extractHashtags } from "@/lib/hashtags/extract";
import { assertWithinImageQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementImagesGenerated } from "@/lib/billing/usage";
import type { RejectionReason } from "@/lib/db/types";
import { runQuickExperiment } from "@/lib/experiments/run";
import { MAX_VARIANT_COUNT, MIN_VARIANT_COUNT } from "@/lib/experiments/generate";
import { dispatchPost, type PostMediaItem } from "@/lib/social/dispatch";
import { applyAttribution } from "@/lib/growth/attribution";
import { vestReferralOnFirstPost } from "@/lib/growth/referrals";
import { isRetryableError } from "@/lib/social/errors";
import { readThreadMeta } from "@/lib/threads/schema";

type ActionResult = { error: string | null };
type GenerateImageResult = { error: string | null; publicUrl: string | null };

const uuid = z.string().uuid();

async function loadPostForWorkspace(postId: string) {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();
  const { data: post, error } = await supabase
    .from("posts")
    .select("*")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (error || !post) return { error: error?.message ?? "Post not found.", post: null, user, supabase };
  return { error: null, post, user, supabase };
}

export async function approvePostAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot approve from ${post.status}.` };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "approved",
    diff: null,
  });

  revalidatePath("/queue");
  return { error: null };
}

// Phase 2 — approve every pending_approval variant that shares the given
// idea_id. Per-variant edit/approve still works; this is the bulk action
// for "the whole idea looks good across all channels".
export async function approveAllVariantsAction(
  ideaId: string,
): Promise<ActionResult & { approved: number }> {
  // idea_id is text (so the generator could later use stable labels); the
  // current shape is UUID-as-text. Accept anything 1-120 chars so we don't
  // brittlely reject future label formats.
  const ideaIdSchema = z.string().trim().min(1).max(120);
  if (!ideaIdSchema.safeParse(ideaId).success) {
    return { error: "Bad idea id.", approved: 0 };
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  // Load all variants of the idea, scoped to the workspace (RLS belt-and-
  // suspenders — the policy already enforces this, but the explicit filter
  // makes the SQL self-documenting).
  const { data: variants, error: loadErr } = await supabase
    .from("posts")
    .select("id, status")
    .eq("workspace_id", ws.id)
    .eq("idea_id", ideaId);
  if (loadErr) return { error: loadErr.message, approved: 0 };
  if (!variants || variants.length === 0) {
    return { error: "Idea not found in this workspace.", approved: 0 };
  }

  const pendingIds = variants.filter((v) => v.status === "pending_approval").map((v) => v.id);
  if (pendingIds.length === 0) {
    return { error: null, approved: 0 };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .in("id", pendingIds);
  if (updateErr) return { error: updateErr.message, approved: 0 };

  // Audit row per variant — keeps the per-post audit trail consistent with
  // single-approval flow, so revoke/history reporting works the same way.
  const approvals = pendingIds.map((postId) => ({
    post_id: postId,
    user_id: user.id,
    action: "approved" as const,
    diff: null,
  }));
  await supabase.from("approvals").insert(approvals);

  revalidatePath("/queue");
  return { error: null, approved: pendingIds.length };
}

// Rejection reasons mirror the CHECK constraint in migration 006 and the
// radio options in queue-row.tsx. Kept in lockstep with the RejectionReason
// type in src/lib/db/types.ts.
const rejectionReasonSchema = z.enum([
  "off_voice",
  "wrong_theme",
  "factually_wrong",
  "other",
]);
const reasonNoteSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((s) => (s && s.length > 0 ? s : null));

// Reschedule — change the day/time a draft (pending) or approved post
// (scheduled) goes out. The cron fires on scheduled_at, so this is the one
// knob that controls "when." Allowed from pending_approval and scheduled;
// posted/rejected rows are immutable. The client sends an ISO-8601 UTC
// instant (already converted from the user's local datetime picker).
const FUTURE_SKEW_MS = 60_000; // tolerate a minute of clock skew
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year cap

export async function reschedulePostAction(
  postId: string,
  scheduledAtIso: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };

  const when = new Date(scheduledAtIso);
  if (Number.isNaN(when.getTime())) return { error: "Invalid date/time." };
  const now = Date.now();
  if (when.getTime() < now - FUTURE_SKEW_MS) {
    return { error: "Pick a time in the future." };
  }
  if (when.getTime() > now + MAX_AHEAD_MS) {
    return { error: "Pick a time within the next year." };
  }

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval" && post.status !== "scheduled") {
    return { error: `Cannot reschedule from ${post.status}.` };
  }

  const iso = when.toISOString();
  if (post.scheduled_at === iso) return { error: null };

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ scheduled_at: iso })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "edited",
    diff: `scheduled_at: ${post.scheduled_at ?? "(none)"} → ${iso}`,
  });

  revalidatePath("/queue");
  return { error: null };
}

export async function rejectPostAction(
  postId: string,
  reason: RejectionReason,
  reasonNote?: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const reasonParsed = rejectionReasonSchema.safeParse(reason);
  if (!reasonParsed.success) return { error: "Pick a rejection reason." };
  const noteParsed = reasonNoteSchema.safeParse(reasonNote);
  if (!noteParsed.success) return { error: "Note must be 500 chars or fewer." };

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot reject from ${post.status}.` };
  }

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "rejected" })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "rejected",
    diff: null,
    reason: reasonParsed.data,
    reason_note: noteParsed.data,
  });

  revalidatePath("/queue");
  return { error: null };
}

export async function editPostAction(postId: string, text: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };

  const max = maxCharsFor(post.channel);
  const editSchema = z.string().trim().min(1).max(max);
  const parsed = editSchema.safeParse(text);
  if (!parsed.success) return { error: `Text must be 1-${max} characters for ${post.channel}.` };
  if (post.status !== "pending_approval") {
    return { error: `Cannot edit from ${post.status}.` };
  }
  if (post.text === parsed.data) return { error: null };

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ text: parsed.data })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "edited",
    diff: shortDiff(post.text, parsed.data),
  });

  revalidatePath("/queue");
  return { error: null };
}

export async function revokePostAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "scheduled") {
    return { error: `Cannot revoke from ${post.status}.` };
  }

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "pending_approval", approved_at: null, revoked_at: new Date().toISOString() })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "unapproved",
    diff: null,
  });

  revalidatePath("/queue");
  return { error: null };
}

function shortDiff(before: string, after: string): string {
  const head = `- ${before}`;
  const tail = `+ ${after}`;
  return `${head}\n${tail}`.slice(0, 4000);
}

const promptSchema = z.string().trim().min(3).max(500);

export async function generatePostImageAction(
  postId: string,
  prompt: string,
): Promise<GenerateImageResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id.", publicUrl: null };
  const parsed = promptSchema.safeParse(prompt);
  if (!parsed.success) {
    return { error: "Prompt must be 3-500 characters.", publicUrl: null };
  }

  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error, publicUrl: null };
  if (post.status !== "pending_approval") {
    return { error: `Cannot generate image from ${post.status}.`, publicUrl: null };
  }

  // Plan-gating: hobby tier has 0 image gens; pro/agency have monthly caps.
  // Check BEFORE the fal.ai call so we don't pay for a generation we'd
  // then have to discard.
  try {
    await assertWithinImageQuota(post.workspace_id, 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, publicUrl: null };
    }
    throw err;
  }

  // Thread the workspace's brand identity (colours / visual tone / voice / logo)
  // into the prompt so generated images match the brand instead of looking
  // generic. loadBrandStyle never throws and returns an empty style when no
  // brand identity is set — applyBrandStyleToPrompt then returns the user's
  // prompt unchanged, so an un-branded workspace keeps today's behaviour.
  const svc = supabaseService();
  const brandStyle = await loadBrandStyle(post.workspace_id, svc);
  const brandedPrompt = applyBrandStyleToPrompt(parsed.data, brandStyle);

  // Generate via the configured provider.
  let img;
  try {
    img = await defaultImageProvider().generate({
      prompt: brandedPrompt,
      aspect: "landscape",
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Image generation failed.",
      publicUrl: null,
    };
  }

  // Upload to Supabase Storage (service-role: RLS-bypass since we just
  // verified workspace membership above via loadPostForWorkspace).
  const ext = img.contentType === "image/png" ? "png" : img.contentType === "image/webp" ? "webp" : "jpg";
  const filename = `${Date.now()}.${ext}`;
  const storagePath = `${post.workspace_id}/${postId}/${filename}`;
  const { error: upErr } = await svc.storage
    .from("post-media")
    .upload(storagePath, img.bytes, {
      contentType: img.contentType,
      upsert: false,
    });
  if (upErr) return { error: `Storage upload failed: ${upErr.message}`, publicUrl: null };

  // Replace any prior image on this post — single image per post for V1.
  // (We could keep a history later by appending instead.)
  const oldMedia = Array.isArray(post.media) ? (post.media as unknown as { storage_path?: string }[]) : [];
  for (const old of oldMedia) {
    if (old?.storage_path) {
      await svc.storage.from("post-media").remove([old.storage_path]);
    }
  }

  const mediaEntry = {
    kind: "image" as const,
    storage_path: storagePath,
    content_type: img.contentType,
    prompt: parsed.data,
    width: img.width,
    height: img.height,
    meta: img.meta,
  };

  const { error: updateErr } = await svc
    .from("posts")
    .update({ media: [mediaEntry] as never })
    .eq("id", postId);
  if (updateErr) {
    await svc.storage.from("post-media").remove([storagePath]);
    return { error: updateErr.message, publicUrl: null };
  }

  // Charge the image quota only after the asset is fully persisted. If a
  // mid-flight error rolled back the post update, we don't want a phantom
  // billing event. Best-effort — counter failure shouldn't block return.
  try {
    await incrementImagesGenerated(post.workspace_id, 1);
  } catch (err) {
    console.warn("Failed to increment images usage counter:", err);
  }

  const { data: pub } = svc.storage.from("post-media").getPublicUrl(storagePath);
  revalidatePath("/queue");
  return { error: null, publicUrl: pub.publicUrl };
}

// Manual upload — user picks an image file from their device. Same storage
// layout as generated images so the cron + dispatcher don't care where the
// bytes came from. Replaces any existing image on the post.
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — fits X v1.1 single-shot.

export async function uploadPostImageAction(formData: FormData): Promise<GenerateImageResult> {
  const postId = (formData.get("postId") as string | null) ?? "";
  if (!uuid.safeParse(postId).success) return { error: "Bad post id.", publicUrl: null };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { error: "No file in upload.", publicUrl: null };
  }
  if (file.size === 0) {
    return { error: "File is empty.", publicUrl: null };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "File too large (max 5MB).", publicUrl: null };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { error: "Only JPEG, PNG, or WebP.", publicUrl: null };
  }

  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error, publicUrl: null };
  if (post.status !== "pending_approval") {
    return { error: `Cannot upload image from ${post.status}.`, publicUrl: null };
  }

  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const filename = `${Date.now()}.${ext}`;
  const storagePath = `${post.workspace_id}/${postId}/${filename}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const svc = supabaseService();
  const { error: upErr } = await svc.storage
    .from("post-media")
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (upErr) return { error: `Storage upload failed: ${upErr.message}`, publicUrl: null };

  // Replace any prior image on this post.
  const oldMedia = Array.isArray(post.media) ? (post.media as unknown as { storage_path?: string }[]) : [];
  for (const old of oldMedia) {
    if (old?.storage_path) {
      await svc.storage.from("post-media").remove([old.storage_path]);
    }
  }

  const mediaEntry = {
    kind: "image" as const,
    storage_path: storagePath,
    content_type: file.type,
    prompt: `User upload: ${file.name}`.slice(0, 200),
    meta: { source: "upload", filename: file.name, size: file.size },
  };

  const { error: updateErr } = await svc
    .from("posts")
    .update({ media: [mediaEntry] as never })
    .eq("id", postId);
  if (updateErr) {
    await svc.storage.from("post-media").remove([storagePath]);
    return { error: updateErr.message, publicUrl: null };
  }

  const { data: pub } = svc.storage.from("post-media").getPublicUrl(storagePath);
  revalidatePath("/queue");
  return { error: null, publicUrl: pub.publicUrl };
}

export async function clearPostImageAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot clear image from ${post.status}.` };
  }

  const svc = supabaseService();
  const oldMedia = Array.isArray(post.media) ? (post.media as unknown as { storage_path?: string }[]) : [];
  for (const old of oldMedia) {
    if (old?.storage_path) {
      await svc.storage.from("post-media").remove([old.storage_path]);
    }
  }
  const { error: updateErr } = await svc
    .from("posts")
    .update({ media: [] as never })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  revalidatePath("/queue");
  return { error: null };
}

// ─────────────────────────────────────────────────────────────
// Phase 6B — runQuickExperimentAction
// ─────────────────────────────────────────────────────────────
//
// Spawn a Quick Experiment from a single approved-or-pending post. We
// generate N variants and queue them as pending_approval drafts in the
// queue (one row per variant, spaced ≥48h apart). The user reviews
// each variant before approval — trust-mode auto-publish is explicitly
// bypassed for experiment variants since the whole point is to compare
// distinct hooks.
//
// Why pending_approval and not scheduled-and-trusted: the parent post
// already shipped; comparing N more drafts that auto-fire feels
// premature. The user explicitly opts into each variant.
const variantCountSchema = z
  .number()
  .int()
  .min(MIN_VARIANT_COUNT)
  .max(MAX_VARIANT_COUNT);

export async function runQuickExperimentAction(
  postId: string,
  variantCount = 3,
): Promise<ActionResult & { experimentId: string | null }> {
  if (!uuid.safeParse(postId).success) {
    return { error: "Bad post id.", experimentId: null };
  }
  const countParsed = variantCountSchema.safeParse(variantCount);
  if (!countParsed.success) {
    return {
      error: `Variant count must be ${MIN_VARIANT_COUNT}-${MAX_VARIANT_COUNT}.`,
      experimentId: null,
    };
  }

  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error, experimentId: null };

  // Only run experiments off posts that have actually shipped or are at
  // minimum scheduled. Spawning variants off a draft we haven't even
  // committed to is premature; the parent is the directional baseline.
  if (post.status !== "posted" && post.status !== "scheduled") {
    return {
      error: `Quick Experiments need a scheduled or posted parent (got ${post.status}).`,
      experimentId: null,
    };
  }

  // Pull the brief for voice context (best-effort — generation still
  // works without it, just less voice-faithful).
  const svc = supabaseService();
  const { data: brief } = await svc
    .from("brand_briefs")
    .select("product_description, voice_profile")
    .eq("workspace_id", post.workspace_id)
    .maybeSingle();

  try {
    const result = await runQuickExperiment({
      workspaceId: post.workspace_id,
      parentPost: post,
      brief: brief
        ? {
            product_description: brief.product_description,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            voice_profile: brief.voice_profile as any,
          }
        : null,
      variantCount: countParsed.data,
    });
    revalidatePath("/queue");
    revalidatePath("/dashboard");
    return { error: null, experimentId: result.experimentId };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Experiment generation failed.",
      experimentId: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 6.10 — setPostHashtagsAction
// ─────────────────────────────────────────────────────────────
//
// Rewrites a pending post's body with the given tag set, appending the
// tags as a trailing block (or none, if `tags` is empty). The action
// also logs the new tag set into hashtag_usage so the recommender
// learns from explicit user toggles — including the negative signal of
// the user *unchecking* a tag (we still record the post's final tag
// set, which is the strongest signal of intent).
//
// Validation:
// - workspace + status checks via loadPostForWorkspace
// - tag normalization (lowercase, no leading #, ASCII only) via
//   extract.ts; anything that fails the regex is silently dropped
// - hard cap from the channel policy
// - resulting body must fit the channel's char cap (truncated if not,
//   matching the editPostAction policy)
const hashtagListSchema = z.array(z.string().trim().min(1).max(100)).max(30);

export async function setPostHashtagsAction(
  postId: string,
  tags: string[],
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const parsed = hashtagListSchema.safeParse(tags);
  if (!parsed.success) return { error: "Bad tag list." };

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot edit tags from ${post.status}.` };
  }

  // Normalize: lowercase, strip leading #, drop empties + dupes.
  const normalized = Array.from(
    new Set(
      parsed.data
        .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
        .filter((t) => /^[a-z0-9_]+$/.test(t)),
    ),
  );

  // Enforce channel cap on the way in — UI cap is a guard rail, server
  // is the binding rule.
  const { getChannelHashtagPolicy } = await import("@/lib/hashtags/rules");
  const policy = getChannelHashtagPolicy(post.channel as Parameters<typeof getChannelHashtagPolicy>[0]);
  if (normalized.length > policy.recommendedCount[1]) {
    return { error: `${post.channel.toUpperCase()} caps at ${policy.recommendedCount[1]} tag${policy.recommendedCount[1] === 1 ? "" : "s"}.` };
  }

  const newText = applyHashtagsToText(post.text, normalized);
  const max = maxCharsFor(post.channel);
  const finalText = newText.length > max ? newText.slice(0, max - 1) + "…" : newText;
  if (finalText === post.text) return { error: null };

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ text: finalText })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  // Audit trail — same shape as editPostAction so /history reads consistently.
  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "edited",
    diff: `tags: ${normalized.map((t) => `#${t}`).join(" ") || "(none)"}`,
  });

  // Log the new tag set to hashtag_usage. Re-fetch the latest metrics
  // (cheap) so we capture the at-the-time engagement; the unique index
  // makes the upsert idempotent against prior records.
  try {
    const svc = supabaseService();
    const { data: latestMetric } = await svc
      .from("post_metrics")
      .select("engagement_rate")
      .eq("post_id", postId)
      .order("fetched_at", { ascending: false })
      .limit(1);
    const engagement = latestMetric?.[0]?.engagement_rate ?? null;
    const rows = extractHashtags(finalText).map((tag) => ({
      workspace_id: post.workspace_id,
      channel: post.channel,
      tag,
      post_id: postId,
      engagement_at_post: engagement,
    }));
    if (rows.length > 0) {
      await svc.from("hashtag_usage").upsert(rows, {
        onConflict: "post_id,tag",
        ignoreDuplicates: true,
      });
    }
  } catch (err) {
    // Best-effort — the post update is the user-visible change. A failed
    // hashtag_usage write only means the recommender misses one signal.
    console.warn("hashtag_usage upsert failed:", err);
  }

  revalidatePath("/queue");
  return { error: null };
}

// ─────────────────────────────────────────────────────────────
// publishNowAction — manual "ship it right now" override
// ─────────────────────────────────────────────────────────────
//
// Approving a post only schedules it; the GitHub Actions cron
// (/api/cron/post-scheduled, every 5 min) is what actually publishes
// scheduled rows whose scheduled_at <= now(). That means a freshly
// approved post can sit up to 5 minutes before it goes live. This action
// gives the user a manual override.
//
// Approach — DIRECT DISPATCH. For a single (non-thread) post we replicate
// the cron's standard publish sequence inline: idempotency-ledger check →
// load the account → dispatchPost() → write the ledger row → flip the post
// to 'posted'/'failed'. dispatchPost() is the same channel-agnostic entry
// point the cron uses, so behaviour (token refresh, media upload, retryable
// transcode handling) is identical. On a RetryableError (async video
// transcode still running) we fall back to scheduled_at=now() so the next
// cron tick resumes — never marking a still-processing render as failed.
//
// X THREADS are the one case we DON'T dispatch directly: they ship via
// postThread() (the cron buckets all tweets of an idea and posts them in
// one ordered pass). Reproducing that orchestration here would be risky, so
// for a thread member we fall back to scheduled_at=now() and let the next
// cron tick run the proper thread path.
export async function publishNowAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval" && post.status !== "scheduled") {
    return { error: `Cannot publish from ${post.status}.` };
  }

  const svc = supabaseService();
  const nowIso = new Date().toISOString();

  // Fall back to the cron for X threads — postThread() owns the ordered
  // multi-tweet path; replicating it here is out of scope and error-prone.
  const isThreadMember =
    post.channel === "x" && readThreadMeta(post.generation_metadata) !== null;
  if (isThreadMember) {
    return scheduleNow(svc, post.id, nowIso);
  }

  // Fall back to the cron for VIDEO posts. A video publish polls the platform's
  // transcode (IG Reels up to 5min, TikTok up to ~2min) — that can never finish
  // inside a serverless function's time budget, so dispatching inline here would
  // 503 the browser even when the post eventually succeeds. The post-scheduled
  // cron tolerates this across ticks via RetryableError, so route video through
  // it. (Channels are video-only/optional: TikTok is video-only, IG video =
  // Reels.) Images + text still publish inline below for instant feedback.
  const hasVideo = ((post.media ?? []) as unknown as PostMediaItem[]).some(
    (m) => m?.kind === "video",
  );
  if (hasVideo) {
    return scheduleNow(svc, post.id, nowIso);
  }

  // Idempotency: if the ledger already has this post (e.g. a prior cron tick
  // posted it but the status update lost a race), reconcile and return.
  const { data: existing } = await svc
    .from("social_posts_ledger")
    .select("external_id")
    .eq("workspace_id", post.workspace_id)
    .eq("channel", post.channel)
    .eq("event_key", `post:${post.id}`)
    .maybeSingle();
  if (existing) {
    await svc
      .from("posts")
      .update({ status: "posted", external_id: existing.external_id, posted_at: nowIso })
      .eq("id", post.id);
    revalidatePath("/queue");
    return { error: null };
  }

  const { data: account, error: acctErr } = await svc
    .from("social_accounts")
    .select("credentials, successful_post_count, status")
    .eq("id", post.social_account_id)
    .maybeSingle();
  if (acctErr || !account) {
    await svc
      .from("posts")
      .update({ status: "failed", failure_reason: (acctErr?.message ?? "account missing").slice(0, 1000) })
      .eq("id", post.id);
    revalidatePath("/queue");
    return { error: "No connected account for this post's channel." };
  }
  // Channel disconnected — credentials are wiped, so publishing would fail with
  // a cryptic auth error. Surface a clear message and leave the post as-is so
  // the user can reconnect and retry.
  if (account.status === "disconnected") {
    return { error: "Channel disconnected — reconnect it to publish this post." };
  }

  try {
    const media = ((post.media ?? []) as unknown) as PostMediaItem[];
    // PLG free-tier attribution: append "Made with marketingmagic" for hobby
    // workspaces with the toggle on; otherwise text is unchanged.
    const text = await applyAttribution(svc, post.workspace_id, post.text);
    const sent = await dispatchPost(
      svc,
      post.channel,
      account.credentials,
      text,
      media,
      post.social_account_id,
    );

    const { error: ledgerErr } = await svc.from("social_posts_ledger").insert({
      workspace_id: post.workspace_id,
      channel: post.channel,
      event_key: `post:${post.id}`,
      external_id: sent.externalId,
      payload: { text: post.text },
    });
    if (ledgerErr && !ledgerErr.message.includes("duplicate")) {
      throw new Error(`ledger write failed: ${ledgerErr.message}`);
    }

    await svc
      .from("posts")
      .update({ status: "posted", external_id: sent.externalId, posted_at: new Date().toISOString() })
      .eq("id", post.id);

    await svc
      .from("social_accounts")
      .update({ successful_post_count: (account.successful_post_count ?? 0) + 1 })
      .eq("id", post.social_account_id);

    // PLG: vest the referral reward if this is the workspace's first-ever
    // posted post (idempotent + service-role; never throws).
    await vestReferralOnFirstPost(svc, post.workspace_id);

    revalidatePath("/queue");
    return { error: null };
  } catch (err) {
    // Retryable (async transcode still running): don't fail the post. Leave
    // it scheduled with scheduled_at=now() so the next cron tick resumes.
    if (isRetryableError(err)) {
      return scheduleNow(svc, post.id, new Date().toISOString());
    }
    const reason = err instanceof Error ? err.message : "publish failed";
    await svc
      .from("posts")
      .update({ status: "failed", failure_reason: reason.slice(0, 1000) })
      .eq("id", post.id);
    revalidatePath("/queue");
    return { error: reason };
  }
}

// Fallback path: mark the post scheduled-for-now so the next cron tick (≤5
// min) publishes it through the normal pipeline. Used for thread members and
// in-flight video transcodes where direct one-shot dispatch isn't safe.
async function scheduleNow(
  svc: ReturnType<typeof supabaseService>,
  postId: string,
  nowIso: string,
): Promise<ActionResult> {
  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "scheduled", scheduled_at: nowIso, approved_at: nowIso })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };
  revalidatePath("/queue");
  return { error: null };
}

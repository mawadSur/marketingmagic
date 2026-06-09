"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { tierFor } from "@/lib/billing/tiers";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";
import { extractFromSource } from "@/lib/sources/extract-claude";
import type { RawSource } from "@/lib/sources/schema";
import { generateFromSource } from "@/lib/sources/generate-from-source";
import { collectThemeSignals } from "@/lib/plan/signals";
import { collectRejectionSignals } from "@/lib/plan/rejection-signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { loadThemeWinners } from "@/lib/analytics/themes";
import { ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { persistVoiceMemoPlan } from "@/lib/voice-memo/persist";
import type { Json } from "@/lib/db/types";

// Phase 2.6/3 — generateFromVoiceMemoAction
//
// The handoff at the bottom of /record after the user has edited the
// transcript. We:
//   1. Re-check the Founder-tier gate (defense-in-depth).
//   2. Run the same Claude extraction the /sources/new path uses, so the
//      voice memo lands as a normal `sources` row (kind='transcript') and
//      gets a summary / themes / quotes / facts we can anchor the plan on.
//   3. Hand off to generateFromSource() with the workspace's connected
//      channels — the Phase 2 multi-channel fan-out is preserved exactly.
//   4. Persist plan + posts via persistVoiceMemoPlan() (the single home for
//      the voice-memo fan-out — same shape as /sources/[id]/actions.ts; every
//      post is stamped source_id + generation_metadata.voice_memo=true).
//
// Returns nothing on success: the action redirects to /plans/[id] so the
// user sees the freshly-generated drafts. Errors come back through the
// useFormState return value on the client.

const VOICE_MEMO_TEXT_MIN = 50;
const VOICE_MEMO_TEXT_MAX = 60_000;

// Per-channel default cadence — copy of SOURCE_CLUSTER_CADENCE in
// /sources/[id]/actions.ts. Voice memos are exploratory bursts, same shape.
const VOICE_MEMO_CADENCE: Record<ChannelId, number> = {
  x: 4,
  bluesky: 4,
  threads: 3,
  linkedin: 2,
  instagram: 2,
  facebook: 2,
  // TikTok is video-only and flag-gated off until the app is audited; keep the
  // cadence low so it doesn't dominate a burst before it can actually publish.
  tiktok: 1,
  // YouTube is video-only and gated on Google OAuth verification + the video-
  // publish allowlist; keep the cadence low for the same reason as TikTok.
  youtube: 1,
};

export type GenerateFromVoiceMemoState = {
  error: string | null;
  planId: string | null;
};

const voiceMemoInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(VOICE_MEMO_TEXT_MIN, `Transcript is too short (need ≥${VOICE_MEMO_TEXT_MIN} chars).`)
    .max(VOICE_MEMO_TEXT_MAX, `Transcript is too long (max ${VOICE_MEMO_TEXT_MAX} chars).`),
  // Optional — if the user opted in to audio retention, the /record client
  // forwards the storage path returned by transcribeRecordingAction so we
  // can attach it to the sources row. Empty string when discarded.
  audioStoragePath: z.string().trim().max(500).optional(),
});

export async function generateFromVoiceMemoAction(
  _prev: GenerateFromVoiceMemoState,
  formData: FormData,
): Promise<GenerateFromVoiceMemoState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();

  const parsed = voiceMemoInputSchema.safeParse({
    text: formData.get("text") ?? "",
    audioStoragePath: formData.get("audioStoragePath") ?? "",
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the transcript.",
      planId: null,
    };
  }

  // EFFECTIVE plan (resolver) so account-level sharing / org inheritance count,
  // not just this workspace's raw plan column.
  if (tierFor(await resolvePlanForWorkspace(ws.id)).id !== "founder") {
    return { error: "Creator tier required to use voice capture.", planId: null };
  }

  const supabase = await supabaseServer();
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);
  if (!briefRes.data) {
    return { error: "Workspace has no brand brief yet.", planId: null };
  }
  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return {
      error: "Connect at least one channel before generating posts.",
      planId: null,
    };
  }

  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> =
    accounts.map((a) => ({
      channel: a.channel as ChannelId,
      handle: a.handle,
      posts_per_week: VOICE_MEMO_CADENCE[a.channel as ChannelId] ?? 3,
    }));

  const estimatedPosts = channelMix.reduce((sum, c) => sum + c.posts_per_week, 0);
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, planId: null };
    }
    throw err;
  }

  // Step 1 — extract structured material from the (possibly-edited)
  // transcript. We synthesize a RawSource on the fly rather than going
  // through fetchSource() because the text is already in hand.
  const rawSource: RawSource = {
    kind: "transcript",
    text: parsed.data.text,
    title: defaultVoiceMemoTitle(parsed.data.text),
    sourceUrl: null,
    filePath: parsed.data.audioStoragePath || null,
  };
  let extracted;
  try {
    const result = await extractFromSource(rawSource);
    extracted = result.extracted;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not extract from the transcript.",
      planId: null,
    };
  }

  // Step 2 — insert the sources row. Same column shape as /sources/new.
  const { data: sourceRow, error: srcErr } = await supabase
    .from("sources")
    .insert({
      workspace_id: ws.id,
      source_kind: "transcript",
      source_url: null,
      file_path: rawSource.filePath,
      title: extracted.title ?? rawSource.title,
      extracted_summary: extracted.summary,
      extracted_quotes: extracted.quotes as unknown as Json,
      extracted_themes: extracted.themes as unknown as Json,
      extracted_facts: extracted.facts as unknown as Json,
      ingested_by: user.id,
    })
    .select("*")
    .single();
  if (srcErr || !sourceRow) {
    return { error: srcErr?.message ?? "Failed to save the voice memo.", planId: null };
  }

  // Step 3 — gather signals + generate the plan. Same shape as the
  // /sources/[id] cluster generation; one-shot (no best-of-3 retry).
  const [themeSignals, rejections, savedPatterns, themeWinners] = await Promise.all([
    collectThemeSignals(ws.id),
    collectRejectionSignals(ws.id),
    loadRecentPatterns(ws.id),
    loadThemeWinners(ws.id, 5),
  ]);

  let result;
  try {
    result = await generateFromSource({
      brief: briefRes.data,
      source: sourceRow,
      channelMix,
      weeks: 1,
      startDate: new Date(),
      winners: themeSignals.winners,
      losers: themeSignals.losers,
      rejections,
      savedPatterns,
      themeWinners,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Generation failed.",
      planId: null,
    };
  }

  // Step 4 — persist plan + posts. The fan-out (idea→variants, voice_score /
  // trust-mode / max-chars rules, source_id + voice_memo stamp, usage
  // increment) lives in persistVoiceMemoPlan() — the single home shared with
  // the equivalent /sources/[id] path's shape.
  const persisted = await persistVoiceMemoPlan({
    workspaceId: ws.id,
    sourceId: sourceRow.id,
    parentPlanId: themeSignals.parent_plan_id,
    brief: briefRes.data,
    accounts,
    result,
  });
  if (!persisted.ok) {
    return { error: persisted.error, planId: null };
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  revalidatePath(`/sources/${sourceRow.id}`);
  // Spec called for /queue?plan_id=... but /queue has no plan_id filter
  // today; /plans/[id] is the existing surface that lists drafts for a
  // single plan (and what /sources/[id]/actions.ts already redirects to).
  redirect(`/plans/${persisted.planId}`);
}

// Derive a short title from the first ~80 chars of the transcript. Used
// as the fallback when Claude's extractor doesn't return a title — voice
// memos sometimes ramble before getting to the point, so we cut on a
// sentence boundary when we can find one.
function defaultVoiceMemoTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "Voice memo";
  const head = trimmed.slice(0, 160);
  const sentenceEnd = head.search(/[.!?]\s/);
  const candidate =
    sentenceEnd > 20 ? head.slice(0, sentenceEnd + 1) : head;
  const shortened = candidate.length > 80 ? candidate.slice(0, 79) + "…" : candidate;
  return `Voice memo — ${shortened}`.slice(0, 280);
}

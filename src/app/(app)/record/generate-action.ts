"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { tierFor } from "@/lib/billing/tiers";
import { extractFromSource } from "@/lib/sources/extract-claude";
import type { RawSource } from "@/lib/sources/schema";
import { generateFromSource } from "@/lib/sources/generate-from-source";
import { collectThemeSignals } from "@/lib/plan/signals";
import { collectRejectionSignals } from "@/lib/plan/rejection-signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { loadThemeWinners } from "@/lib/analytics/themes";
import {
  channelSpec,
  ENABLED_CHANNELS,
  type ChannelId,
} from "@/lib/channels/registry";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
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
//   4. Persist plan + posts (mirrors /sources/[id]/actions.ts; we duplicate
//      the persistence block rather than refactor it to keep slice-2.6/3
//      additive and avoid touching code the Discord / memberships agents
//      are also editing).
//
// Returns nothing on success: the action redirects to /plans/[id] so the
// user sees the freshly-generated drafts. Errors come back through the
// useFormState return value on the client.

const VOICE_MEMO_TEXT_MIN = 50;
const VOICE_MEMO_TEXT_MAX = 60_000;
const VOICE_SCORE_THRESHOLD = 70;

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

  const svc = supabaseService();
  const { data: wsRow } = await svc
    .from("workspaces")
    .select("plan")
    .eq("id", ws.id)
    .maybeSingle();
  if (tierFor(wsRow?.plan).id !== "founder") {
    return { error: "Founder tier required to use voice capture.", planId: null };
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

  // Step 4 — persist plan + posts. Mirrors /sources/[id]/actions.ts.
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: result.plan.plan_name,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id: themeSignals.parent_plan_id,
      generation_prompt: result.plan.overview,
      generation_response: result.plan as unknown as Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { error: planErr?.message ?? "Failed to save plan.", planId: null };
  }

  const accountByChannel = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);
  const hasVoiceProfile = briefRes.data.voice_profile != null;

  type FlatVariant = {
    channel: string;
    text: string;
    theme: string;
    suggested_scheduled_at: string;
    rationale: string;
    image_prompt?: string;
    idea_id: string | null;
    idea_label: string | null;
    voice_score?: number;
  };
  let flatVariants: FlatVariant[];
  if (result.plan.ideas) {
    flatVariants = result.plan.ideas.flatMap((idea) => {
      const ideaId = crypto.randomUUID();
      return idea.variants
        .filter((v) => !v.skip)
        .map((v) => ({
          channel: v.channel,
          text: v.text,
          theme: idea.theme,
          suggested_scheduled_at: idea.suggested_scheduled_at,
          rationale: v.rationale,
          image_prompt: v.image_prompt,
          idea_id: ideaId,
          idea_label: idea.idea_label,
          voice_score: v.voice_score,
        }));
    });
  } else {
    flatVariants = (result.plan.posts ?? []).map((p) => ({
      channel: p.channel,
      text: p.text,
      theme: p.theme,
      suggested_scheduled_at: p.suggested_scheduled_at,
      rationale: p.rationale,
      image_prompt: p.image_prompt,
      idea_id: null,
      idea_label: null,
      voice_score: p.voice_score,
    }));
  }

  const postsPayload = flatVariants.flatMap((p) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) return [];
    const voiceScore = typeof p.voice_score === "number" ? p.voice_score : null;
    const lowConfidence =
      hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    const trusted = acct.trust_mode === true && !lowConfidence;
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;
    return [
      {
        workspace_id: ws.id,
        plan_id: planRow.id,
        social_account_id: acct.id,
        channel: acct.channel,
        text,
        theme: p.theme,
        scheduled_at: p.suggested_scheduled_at,
        status: (trusted ? "scheduled" : "pending_approval") as
          | "scheduled"
          | "pending_approval",
        voice_score: voiceScore,
        low_confidence: lowConfidence,
        idea_id: p.idea_id,
        source_id: sourceRow.id,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          source_id: sourceRow.id,
          // Tag the persistence path so analytics can distinguish
          // voice-memo-anchored posts from URL/paste-anchored ones.
          origin: "voice_memo",
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return {
      error: "Claude generated only posts for channels you haven't connected.",
      planId: null,
    };
  }

  const { error: postsErr } = await svc.from("posts").insert(postsPayload);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, planId: null };
  }

  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  revalidatePath(`/sources/${sourceRow.id}`);
  // Spec called for /queue?plan_id=... but /queue has no plan_id filter
  // today; /plans/[id] is the existing surface that lists drafts for a
  // single plan (and what /sources/[id]/actions.ts already redirects to).
  redirect(`/plans/${planRow.id}`);
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

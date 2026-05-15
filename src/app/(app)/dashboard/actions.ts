"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { generatePlan, type PlanGenResult } from "@/lib/plan/generate";
import { collectThemeSignals } from "@/lib/plan/signals";
import { collectRejectionSignals } from "@/lib/plan/rejection-signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { loadThemeWinners } from "@/lib/analytics/themes";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import type { Channel } from "@/lib/db/types";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import { getOptimalWindows, nextOptimalSlotIso } from "@/lib/timing/analyze";

// Phase 6.9 — one-click regen action for the Neglected Themes widget.
//
// Generates 2-3 posts in a single theme using the workspace's existing
// channel mix, snaps the suggested_scheduled_at to each channel's next
// optimal window (Smart Timing, src/lib/timing/analyze.ts), and drops
// the result into the queue as pending_approval. We bias toward
// pending_approval even on trusted channels — themed regen is too
// targeted to auto-publish without a human glance.

export type RegenerateThemeResult = {
  error: string | null;
  planId: string | null;
  postsCreated: number;
};

const VOICE_SCORE_THRESHOLD = 70;
const MIN_COUNT = 2;
const MAX_COUNT = 3;

export async function regenerateThemeAction(
  theme: string,
  countRaw: number = 3,
): Promise<RegenerateThemeResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const trimmed = (theme ?? "").trim();
  if (!trimmed) {
    return { error: "Theme is required.", planId: null, postsCreated: 0 };
  }
  const count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.floor(countRaw)));

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
    return {
      error: "Workspace has no brand brief. Save it first.",
      planId: null,
      postsCreated: 0,
    };
  }
  const accounts = accountsRes.data ?? [];
  if (accounts.length === 0) {
    return {
      error: "Connect at least one social account before regenerating a theme.",
      planId: null,
      postsCreated: 0,
    };
  }

  // Build a single-week channel mix using whatever the workspace has
  // connected. posts_per_week=count means a single week of `count` ideas
  // per channel (we drop variants at insert-time per channel mismatch).
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> = [];
  for (const a of accounts) {
    if (!ENABLED_CHANNELS.includes(a.channel as ChannelId)) continue;
    channelMix.push({
      channel: a.channel as ChannelId,
      handle: a.handle,
      posts_per_week: count,
    });
  }
  if (channelMix.length === 0) {
    return {
      error: "No supported channels are connected.",
      planId: null,
      postsCreated: 0,
    };
  }

  // Quota check before we burn Anthropic tokens. Charge after insert.
  const estimatedPosts = channelMix.length * count;
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, planId: null, postsCreated: 0 };
    }
    throw err;
  }

  // Pull the same signal sources the main /plans/new flow uses, but
  // synthesize an extra retryNote that locks the model to the requested
  // theme. We don't add a new schema field — the existing retryNote pipe
  // is the cheapest carrier for this one-shot instruction.
  const [themeSignals, rejections, savedPatterns, themeWinners] = await Promise.all([
    collectThemeSignals(ws.id),
    collectRejectionSignals(ws.id),
    loadRecentPatterns(ws.id),
    loadThemeWinners(ws.id, 5),
  ]);
  const { winners, losers, parent_plan_id } = themeSignals;

  const themeNote =
    `Generate exactly ${count} ideas, all tagged with theme "${trimmed}". ` +
    `This is a single-theme regen — every idea must use that theme tag verbatim, ` +
    `and the angle should vary post-to-post within that theme.`;

  let result: PlanGenResult;
  try {
    result = await generatePlan({
      brief: briefRes.data,
      channelMix,
      weeks: 1,
      startDate: new Date(),
      winners,
      losers,
      rejections,
      savedPatterns,
      themeWinners,
      retryNote: themeNote,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Generation failed.",
      planId: null,
      postsCreated: 0,
    };
  }

  // Plan-level row.
  const svc = supabaseService();
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: `Regen · ${trimmed}`,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id,
      generation_prompt: `Single-theme regen: ${trimmed}`,
      generation_response: result.plan as unknown as import("@/lib/db/types").Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return {
      error: planErr?.message ?? "Failed to save plan.",
      planId: null,
      postsCreated: 0,
    };
  }

  // Resolve channel → account map. Same shape as /plans/new.
  const accountByChannel = new Map<string, typeof accounts[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);

  // Snap each variant's suggested_scheduled_at to the next optimal slot
  // for its channel. Falls back to the model's suggestion when Smart
  // Timing can't compute (cold-start). Cache per channel so we don't
  // recompute the optimal-windows grid for every post.
  const optimalByChannel = new Map<string, string | null>();
  async function getNextSlot(channel: string): Promise<string | null> {
    if (optimalByChannel.has(channel)) return optimalByChannel.get(channel) ?? null;
    try {
      const windows = await getOptimalWindows(ws.id, channel, { topN: 5 });
      const slot = nextOptimalSlotIso(windows, { horizonDays: 7, topK: 5 });
      optimalByChannel.set(channel, slot);
      return slot;
    } catch {
      optimalByChannel.set(channel, null);
      return null;
    }
  }

  type FlatVariant = {
    channel: string;
    text: string;
    theme: string;
    suggested_scheduled_at: string;
    rationale: string;
    image_prompt?: string;
    idea_id: string | null;
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
          // Force-correct the theme tag so the model can't slip a different
          // label in. Single-theme regen means every row stays in the bucket
          // we asked for, no matter what Claude returned.
          theme: trimmed,
          suggested_scheduled_at: idea.suggested_scheduled_at,
          rationale: v.rationale,
          image_prompt: v.image_prompt,
          idea_id: ideaId,
          voice_score: v.voice_score,
        }));
    });
  } else {
    flatVariants = (result.plan.posts ?? []).map((p) => ({
      channel: p.channel,
      text: p.text,
      theme: trimmed,
      suggested_scheduled_at: p.suggested_scheduled_at,
      rationale: p.rationale,
      image_prompt: p.image_prompt,
      idea_id: null,
      voice_score: p.voice_score,
    }));
  }

  // Cap at the requested count of *ideas*. When ideas[] is set we count by
  // unique idea_id; when posts[] (legacy) we count rows. Either way we
  // truncate so a chatty model can't blow past the budget.
  const desiredIdeaIds = new Set<string | null>();
  const limitedVariants: FlatVariant[] = [];
  for (const v of flatVariants) {
    if (v.idea_id && !desiredIdeaIds.has(v.idea_id)) {
      if (desiredIdeaIds.size >= count) continue;
      desiredIdeaIds.add(v.idea_id);
    } else if (!v.idea_id) {
      // Legacy / single-channel: count by row.
      if (limitedVariants.length >= count) break;
    }
    limitedVariants.push(v);
  }

  const hasVoiceProfile = briefRes.data.voice_profile != null;
  const skipped: string[] = [];
  const postsPayload: Array<{
    workspace_id: string;
    plan_id: string;
    social_account_id: string;
    channel: Channel;
    text: string;
    theme: string;
    scheduled_at: string;
    status: "pending_approval";
    voice_score: number | null;
    low_confidence: boolean;
    idea_id: string | null;
    generation_metadata: import("@/lib/db/types").Json;
  }> = [];

  for (const v of limitedVariants) {
    const acct = accountByChannel.get(v.channel);
    if (!acct) {
      skipped.push(v.channel);
      continue;
    }
    const voiceScore = typeof v.voice_score === "number" ? v.voice_score : null;
    const lowConfidence =
      hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = v.text.length > max ? v.text.slice(0, max - 1) + "…" : v.text;
    const snapped = (await getNextSlot(acct.channel)) ?? v.suggested_scheduled_at;

    postsPayload.push({
      workspace_id: ws.id,
      plan_id: planRow.id,
      social_account_id: acct.id,
      channel: acct.channel as Channel,
      text,
      theme: v.theme,
      scheduled_at: snapped,
      // Always pending_approval — themed regen is a targeted assist, the
      // user should glance before it ships.
      status: "pending_approval",
      voice_score: voiceScore,
      low_confidence: lowConfidence,
      idea_id: v.idea_id,
      generation_metadata: {
        rationale: v.rationale,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
        auto_scheduled: false,
        image_prompt: v.image_prompt ?? null,
        regen_theme: v.theme,
        regen_source: "neglected_themes_widget",
        scheduled_via: snapped === v.suggested_scheduled_at ? "model" : "smart_timing",
      },
    });
  }

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return {
      error: "Generated posts didn't match any connected channel.",
      planId: null,
      postsCreated: 0,
    };
  }

  const { error: insertErr } = await svc.from("posts").insert(postsPayload);
  if (insertErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: insertErr.message, planId: null, postsCreated: 0 };
  }

  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/dashboard");
  revalidatePath("/queue");
  if (skipped.length > 0) {
    console.warn("Theme regen dropped posts for unconnected channels:", skipped);
  }
  return { error: null, planId: planRow.id, postsCreated: postsPayload.length };
}

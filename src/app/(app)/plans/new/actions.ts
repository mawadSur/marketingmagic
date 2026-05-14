"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { generatePlan, type PlanGenResult } from "@/lib/plan/generate";
import { collectThemeSignals } from "@/lib/plan/signals";
import { collectRejectionSignals } from "@/lib/plan/rejection-signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { recommendHashtagsForChannels } from "@/lib/hashtags/recommend";
import { backfillHashtagsForPosts } from "@/lib/hashtags/backfill";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import { getOptimalWindows, nextOptimalSlotIso } from "@/lib/timing/analyze";
import type { OptimalWindowsResult } from "@/lib/timing/schema";

// Voice-score threshold: posts below this auto-regenerate (up to MAX_RETRIES
// passes); if still below after retries we keep the best-of-3 and flag as
// low_confidence. The flag also forces pending_approval even under trust
// mode — we never auto-publish a draft Claude isn't confident sounds like
// the brand.
const VOICE_SCORE_THRESHOLD = 70;
const MAX_RETRIES = 2; // first pass + 2 retries = best-of-3

export type GeneratePlanState = { error: string | null; planId: string | null };

const channelSelectionSchema = z.object({
  accountId: z.string().uuid(),
  postsPerWeek: z.number().int().min(1).max(28),
});

const formSchema = z.object({
  weeks: z.number().int().min(1).max(4),
  channels: z.array(channelSelectionSchema).min(1).max(8),
});

function parseFormData(formData: FormData): z.SafeParseReturnType<unknown, z.infer<typeof formSchema>> {
  const weeks = Number(formData.get("weeks") ?? "1");
  const channels: Array<{ accountId: string; postsPerWeek: number }> = [];

  // Form fields shape: include_<id> = "on" + posts_<id> = "<n>".
  // We iterate include_* keys and read the matching posts field.
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("include_")) continue;
    if (value !== "on") continue;
    const accountId = key.slice("include_".length);
    const ppw = Number(formData.get(`posts_${accountId}`) ?? "0");
    channels.push({ accountId, postsPerWeek: ppw });
  }

  return formSchema.safeParse({ weeks, channels });
}

export async function generatePlanAction(
  _prev: GeneratePlanState,
  formData: FormData,
): Promise<GeneratePlanState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = parseFormData(formData);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Pick at least one channel and a posts/week count.",
      planId: null,
    };
  }

  const supabase = await supabaseServer();

  // Load brief + all selected accounts in one trip; reject any that don't
  // belong to the workspace or aren't connected.
  const accountIds = parsed.data.channels.map((c) => c.accountId);
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected")
      .in("id", accountIds),
  ]);
  if (!briefRes.data) return { error: "Workspace has no brand brief.", planId: null };
  const accounts = accountsRes.data ?? [];
  if (accounts.length !== accountIds.length) {
    return { error: "One or more selected accounts not found.", planId: null };
  }

  // Build channelMix. Skip any account whose channel isn't enabled.
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> = [];
  for (const sel of parsed.data.channels) {
    const acct = accountById.get(sel.accountId);
    if (!acct) continue;
    if (!ENABLED_CHANNELS.includes(acct.channel as ChannelId)) continue;
    channelMix.push({
      channel: acct.channel as ChannelId,
      handle: acct.handle,
      posts_per_week: sel.postsPerWeek,
    });
  }
  if (channelMix.length === 0) {
    return { error: "No supported channels selected.", planId: null };
  }

  // Signals share across all channels for now — V2 keeps theme signals
  // channel-agnostic. Per-channel signal split is a future refinement.
  // Rejection signals (Phase 1) and saved playbook patterns (Phase 6.7)
  // ride alongside the theme signals.
  // Phase 6.10: per-channel hashtag suggestions, drawn from this
  // workspace's own tag history (free, no LLM call). The generator
  // weaves them in as soft hints; the /queue chip row is the binding UI.
  const channelsToScan = Array.from(new Set(channelMix.map((c) => c.channel)));
  const [themeSignals, rejections, savedPatterns, hashtagSuggestions] = await Promise.all([
    collectThemeSignals(ws.id),
    collectRejectionSignals(ws.id),
    loadRecentPatterns(ws.id),
    recommendHashtagsForChannels(ws.id, channelsToScan),
  ]);
  const { winners, losers, parent_plan_id } = themeSignals;

  // Estimate posts BEFORE calling Claude so we don't burn tokens for a
  // workspace that's over quota. We charge for what we actually generated
  // below, so the estimate is an upper bound — the AI sometimes drops
  // posts for unsupported channels.
  const estimatedPosts = channelMix.reduce((sum, c) => sum + c.posts_per_week * parsed.data.weeks, 0);
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, planId: null };
    }
    throw err;
  }

  // Best-of-3 retry loop. Generate, score, keep if average voice >=
  // threshold OR we've exhausted retries. We keep the best attempt so
  // far rather than throwing it away on the next pass.
  //
  // Skip the loop entirely if the brief has no voice_profile — without
  // it Claude has nothing to score against and we'd just burn tokens.
  const startDate = new Date();
  const hasVoiceProfile = briefRes.data.voice_profile != null;
  let result: PlanGenResult;
  let bestAttempt: { result: PlanGenResult; avgVoice: number } | null = null;
  try {
    const maxAttempts = hasVoiceProfile ? MAX_RETRIES + 1 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const retryNote =
        attempt > 0 && bestAttempt
          ? `Previous attempt averaged voice_score ${bestAttempt.avgVoice.toFixed(1)} ` +
            `(threshold ${VOICE_SCORE_THRESHOLD}). Re-read the voice profile carefully — match ` +
            `the opener patterns and signature phrases more tightly this pass, and score ` +
            `yourself more honestly. Posts scored below ${VOICE_SCORE_THRESHOLD} block trust-mode auto-publish.`
          : undefined;

      const attemptResult = await generatePlan({
        brief: briefRes.data,
        channelMix,
        weeks: parsed.data.weeks,
        startDate,
        winners,
        losers,
        rejections,
        savedPatterns,
        retryNote,
        hashtagSuggestions,
      });

      const avgVoice = averageVoiceScore(attemptResult);
      if (!bestAttempt || avgVoice > bestAttempt.avgVoice) {
        bestAttempt = { result: attemptResult, avgVoice };
      }
      if (!hasVoiceProfile || avgVoice >= VOICE_SCORE_THRESHOLD) break;
    }
    if (!bestAttempt) throw new Error("Generation produced no attempts.");
    result = bestAttempt.result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Generation failed.", planId: null };
  }

  // Persist with service role (RLS-bypass for atomic plan+posts insert).
  const svc = supabaseService();
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + parsed.data.weeks * 7 * 24 * 60 * 60 * 1000);

  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: result.plan.plan_name,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id,
      generation_prompt: result.plan.overview,
      generation_response: result.plan as unknown as import("@/lib/db/types").Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { error: planErr?.message ?? "Failed to save plan.", planId: null };
  }

  // Resolve each generated post to a social_account_id by channel. If a post
  // names a channel we don't have an account for (Claude misbehaved), we
  // drop it from the batch and surface a soft error.
  const accountByChannel = new Map<string, typeof accounts[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);

  const skipped: string[] = [];
  // Phase 2: the schema supports either `ideas[]` (new) or `posts[]` (legacy).
  // - ideas: one idea → N variants; we mint a UUID idea_id per idea and tag
  //   every variant row with it so the queue can group them.
  // - posts: legacy single-channel shape — each post stands alone with
  //   idea_id=NULL (no grouping).
  //
  // Trust-mode policy for multi-variant ideas: each variant inherits the
  // trust state of *its* social_account independently. So you can have the X
  // variant auto-scheduled (trusted channel) while the LinkedIn variant of
  // the same idea waits in pending_approval (untrusted channel). This
  // matches the existing per-channel trust model and keeps the per-variant
  // approve/edit UX intact.
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

  // Phase 6.5 — Smart Timing integration.
  //
  // Replace each variant's `suggested_scheduled_at` (Claude's pick) with the
  // workspace's next-available optimal slot for that channel. We preserve the
  // original ordering (sorted by Claude's suggested time) so earlier ideas
  // still land in earlier slots — Smart Timing only swaps *when within the day*
  // each post fires, not which idea ships first.
  //
  // Algorithm:
  //   1. Group variants by channel.
  //   2. Fetch `getOptimalWindows(ws, channel)` ONCE per channel (parallel).
  //   3. Sort each channel's variants by suggested_scheduled_at (stable).
  //   4. Walk the channel's variants in order; for each, call
  //      `nextOptimalSlotIso(result, { from: cursor })`. Advance the cursor
  //      past the returned slot (+ 2h, since buckets are 2h) so two posts on
  //      the same channel never collide on the same window.
  //   5. Confidence rules (the *top* slot decides the source label):
  //        - top.confidence ≥ medium ........... timing_source = 'optimal'
  //        - top.confidence == low / isBaseline   timing_source = 'baseline'
  //          (still uses the baseline-driven optimal slot for the queue)
  //   6. Trust-mode cold-start fallback (per-post, applied later in the
  //      flatMap below): when a post is *trusted* and the slot label is
  //      'baseline' (no high-confidence observed data yet), we revert to
  //      Claude's suggested time and mark `timing_source = 'claude_suggested'`
  //      — we don't want to auto-publish into a guessed slot.
  type TimingSource = "optimal" | "claude_suggested" | "baseline";
  const variantsByChannel = new Map<string, number[]>();
  flatVariants.forEach((v, idx) => {
    const list = variantsByChannel.get(v.channel) ?? [];
    list.push(idx);
    variantsByChannel.set(v.channel, list);
  });

  const channels = [...variantsByChannel.keys()];
  const windowsByChannel = new Map<string, OptimalWindowsResult>();
  await Promise.all(
    channels.map(async (ch) => {
      try {
        const res = await getOptimalWindows(ws.id, ch);
        windowsByChannel.set(ch, res);
      } catch (err) {
        // Smart Timing must never block plan generation — log and skip.
        console.warn(`Smart Timing failed for channel ${ch}, falling back to Claude:`, err);
      }
    }),
  );

  const slotByVariantIdx = new Map<number, { scheduledAt: string; source: TimingSource }>();
  const now = new Date();
  for (const [channel, idxs] of variantsByChannel.entries()) {
    const windows = windowsByChannel.get(channel);
    // Sort variants for this channel by Claude's suggested time (ascending)
    // so later ideas keep later slots.
    const ordered = [...idxs].sort((a, b) =>
      flatVariants[a].suggested_scheduled_at.localeCompare(flatVariants[b].suggested_scheduled_at),
    );

    // Channel has no windows result (Smart Timing threw) — defer entirely to
    // Claude's suggestion for every variant on this channel.
    if (!windows) {
      for (const i of ordered) {
        slotByVariantIdx.set(i, {
          scheduledAt: flatVariants[i].suggested_scheduled_at,
          source: "claude_suggested",
        });
      }
      continue;
    }

    // Top-slot confidence drives the source label for this channel. If the
    // best window is still baseline-only the workspace is "cold" for this
    // channel and downstream trust-mode logic will see source='baseline'.
    const topSlot = windows.top[0];
    const channelSource: TimingSource =
      topSlot && !topSlot.isBaseline && topSlot.confidence !== "low"
        ? "optimal"
        : "baseline";

    // Cursor advances past each assigned slot so multiple variants on the
    // same channel don't collide on a single window.
    let cursor = now;
    for (const i of ordered) {
      // Honour Claude's suggested time as a baseline minimum — if Claude
      // wanted a slot further in the future than `cursor`, start the search
      // there to preserve sequencing.
      const claudeDate = new Date(flatVariants[i].suggested_scheduled_at);
      const searchFrom =
        Number.isFinite(claudeDate.getTime()) && claudeDate.getTime() > cursor.getTime()
          ? claudeDate
          : cursor;
      const iso = nextOptimalSlotIso(windows, { from: searchFrom, horizonDays: 14 });
      if (iso) {
        slotByVariantIdx.set(i, { scheduledAt: iso, source: channelSource });
        // Push cursor 2h past this slot (the bucket width) so the next
        // variant on this channel lands in a different window.
        cursor = new Date(new Date(iso).getTime() + 2 * 60 * 60 * 1000);
      } else {
        // No slot found inside the horizon — keep Claude's suggestion.
        slotByVariantIdx.set(i, {
          scheduledAt: flatVariants[i].suggested_scheduled_at,
          source: "claude_suggested",
        });
      }
    }
  }

  const postsPayload = flatVariants.flatMap((p, idx) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
    // Per-post voice fields. low_confidence is the *post-retry* signal —
    // we already kept the best-of-3 above, so if it's still below threshold
    // the user should see + approve it before it ships. Trust mode is
    // explicitly overridden for low_confidence drafts.
    const voiceScore = typeof p.voice_score === "number" ? p.voice_score : null;
    const lowConfidence =
      hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    const trusted = acct.trust_mode === true && !lowConfidence;
    // Enforce per-channel max chars. If Claude exceeded, truncate rather
    // than reject — losing one line beats throwing the plan away.
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;

    // Smart Timing slot resolution. Trust-mode cold-start override: if the
    // post would auto-publish (trusted) AND the slot source is purely
    // baseline (no high-confidence observed data yet for this channel), we
    // revert to Claude's suggested time. Auto-publishing into a baseline
    // guess feels worse than auto-publishing into the time Claude picked.
    const assigned = slotByVariantIdx.get(idx) ?? {
      scheduledAt: p.suggested_scheduled_at,
      source: "claude_suggested" as TimingSource,
    };
    let scheduledAt = assigned.scheduledAt;
    let timingSource = assigned.source;
    if (trusted && timingSource === "baseline") {
      scheduledAt = p.suggested_scheduled_at;
      timingSource = "claude_suggested";
    }

    return [
      {
        workspace_id: ws.id,
        plan_id: planRow.id,
        social_account_id: acct.id,
        channel: acct.channel,
        text,
        theme: p.theme,
        scheduled_at: scheduledAt,
        status: (trusted ? "scheduled" : "pending_approval") as "scheduled" | "pending_approval",
        voice_score: voiceScore,
        low_confidence: lowConfidence,
        idea_id: p.idea_id,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          timing_source: timingSource,
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: "Claude generated only posts for channels you haven't connected.", planId: null };
  }

  const { data: insertedPosts, error: postsErr } = await svc
    .from("posts")
    .insert(postsPayload)
    .select("id");
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, planId: null };
  }

  // Charge billing usage for the actual number of posts inserted (we may
  // have dropped some for unsupported channels). Best-effort — a counter
  // failure here shouldn't block the user from seeing their plan.
  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  // Phase 6.10: scan the freshly-inserted post bodies for hashtags and
  // log them to hashtag_usage so the next plan generation can learn from
  // what the model actually wrote. Best-effort; failure here only means
  // the recommender misses a few rows.
  try {
    const newIds = (insertedPosts ?? []).map((r) => r.id);
    if (newIds.length > 0) await backfillHashtagsForPosts(newIds);
  } catch (err) {
    console.warn("Hashtag backfill on new plan failed:", err);
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  if (skipped.length > 0) {
    // Best-effort: log it. We still want to redirect to the plan since most
    // posts landed; surfacing as a banner there is a future polish.
    console.warn("Plan generator dropped posts for unconnected channels:", skipped);
  }
  redirect(`/plans/${planRow.id}`);
}

// Average voice_score across all posts in a generation result. Posts that
// omit voice_score (legacy or when no profile is set) count as 100 — they
// shouldn't penalise the average for workspaces without voice profiles,
// and the caller checks hasVoiceProfile before consulting this anyway.
function averageVoiceScore(result: PlanGenResult): number {
  // Plan may use either the new ideas[] shape (variants nested per idea) or
  // the legacy posts[] shape. Collect voice_scores from whichever is present.
  const scores: number[] = [];
  if (result.plan.ideas) {
    for (const idea of result.plan.ideas) {
      for (const v of idea.variants) {
        if (typeof v.voice_score === "number" && !v.skip) scores.push(v.voice_score);
      }
    }
  } else if (result.plan.posts) {
    for (const p of result.plan.posts) {
      if (typeof p.voice_score === "number") scores.push(p.voice_score);
    }
  }
  if (scores.length === 0) return 100;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

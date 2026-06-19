"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
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
import { gateBatchForDedup } from "@/lib/dedup/gate";
import type { Json } from "@/lib/db/types";

// /sources/[id] — "Generate cluster" server action.
//
// Loads the source row + workspace's connected channels + brief, hands off
// to generateFromSource() (which delegates to the standard plan generator
// with `source` injected), and persists the result through the same
// idea→variants fan-out used by /plans/new/actions.ts — with one extra
// touch: every inserted post row carries `source_id` so engagement metrics
// can be rolled up per source.
//
// Why not call into plans/new's action directly?
// - That action reads form data + computes weeks/channelMix from a form;
//   adapting it for "use the workspace's already-connected channels with
//   default cadence" would mean a 5-arg internal helper and a refactor
//   of a file the Discord agent is also touching. Cleaner to duplicate
//   the small persistence block here and keep boundaries crisp.

const VOICE_SCORE_THRESHOLD = 70;

export type GenerateClusterState = { error: string | null; planId: string | null };

const idSchema = z.string().uuid();

// Per-channel default cadence for source clusters. A source typically
// generates a 1-week burst across whatever the user has connected — we
// don't ask them to pick channels because the source itself is the lens.
// Numbers are intentionally lower than the /plans/new defaults: a source
// cluster is a focused exploration, not a continuous calendar.
const SOURCE_CLUSTER_CADENCE: Record<ChannelId, number> = {
  x: 4,
  bluesky: 4,
  threads: 3,
  linkedin: 2,
  instagram: 2,
  facebook: 2,
  // TikTok is video-only and flag-gated off until the app is audited; keep the
  // cadence low so it doesn't dominate a focused source burst.
  tiktok: 1,
  // YouTube is video-only and gated on Google OAuth verification + the video-
  // publish allowlist; keep the cadence low for the same reason as TikTok.
  youtube: 1,
};

export async function generateClusterAction(
  _prev: GenerateClusterState,
  formData: FormData,
): Promise<GenerateClusterState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const sourceId = formData.get("source_id");
  if (typeof sourceId !== "string" || !idSchema.safeParse(sourceId).success) {
    return { error: "Bad source id.", planId: null };
  }

  const supabase = await supabaseServer();

  const [sourceRes, briefRes, accountsRes] = await Promise.all([
    supabase.from("sources").select("*").eq("id", sourceId).eq("workspace_id", ws.id).maybeSingle(),
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);

  if (!sourceRes.data) return { error: "Source not found.", planId: null };
  if (!briefRes.data) return { error: "Workspace has no brand brief.", planId: null };

  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return {
      error: "Connect at least one channel before generating a cluster.",
      planId: null,
    };
  }

  // Build channelMix from the workspace's connected accounts. The source
  // cluster uses the per-channel default cadence above; users who want
  // different cadence can still hand-edit posts after generation lands in
  // the queue.
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> = [];
  for (const a of accounts) {
    const ch = a.channel as ChannelId;
    channelMix.push({
      channel: ch,
      handle: a.handle,
      posts_per_week: SOURCE_CLUSTER_CADENCE[ch] ?? 3,
    });
  }

  // Quota check — be generous and assume 1 week of generations.
  const estimatedPosts = channelMix.reduce((sum, c) => sum + c.posts_per_week, 0);
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, planId: null };
    }
    throw err;
  }

  const [themeSignals, rejections, savedPatterns, themeWinners] = await Promise.all([
    collectThemeSignals(ws.id),
    collectRejectionSignals(ws.id),
    loadRecentPatterns(ws.id),
    loadThemeWinners(ws.id, 5),
  ]);

  // One-shot generation. We deliberately skip the best-of-3 retry loop
  // used by /plans/new: source clusters are exploratory, the user reviews
  // every post in the queue, and burning 3x the tokens on a feature that
  // hasn't proven its lift yet is premature.
  let result;
  try {
    result = await generateFromSource({
      brief: briefRes.data,
      source: sourceRes.data,
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

  // Persist plan + posts. Mirrors the idea→variants fan-out in
  // /plans/new/actions.ts; the one delta is that every inserted post row
  // carries `source_id` so dashboards can attribute engagement back.
  const svc = supabaseService();
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

  // Keyed by string (raw channel id) to match the plan generator's per-
  // variant channel field — Claude emits the channel as a plain enum
  // string, not the Channel TS type, and we don't want a type cast in
  // the hot path.
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

  const skipped: string[] = [];
  const postsPayload = flatVariants.flatMap((p) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
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
        // Phase 2.5: tag every post with the source it came from. NULL on
        // any post that wasn't generated through this path — the analytics
        // dashboard treats NULL as "not source-attributed".
        source_id: sourceId,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          source_id: sourceId,
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

  const gatedPayload = await gateBatchForDedup(ws.id, postsPayload);

  const { error: postsErr } = await svc.from("posts").insert(gatedPayload);
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
  revalidatePath(`/sources/${sourceId}`);
  if (skipped.length > 0) {
    console.warn("Source cluster dropped posts for unconnected channels:", skipped);
  }
  redirect(`/plans/${planRow.id}`);
}

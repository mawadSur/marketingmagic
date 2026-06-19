"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  getActiveWorkspaceOrRedirect,
  getAuthedUserOrRedirect,
} from "@/lib/workspace";
import { fetchSource, ColdSourceError } from "@/lib/sources/fetch";
import { extractFromSource } from "@/lib/sources/extract-claude";
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

// /sources/build-in-public — the wedge's killer feature.
//
// A solo founder pastes their raw build updates (changelog / launch notes /
// brain-dump) and gets a week of authentic build-in-public posts, led by X,
// landing as drafts in their queue.
//
// HOW THIS REUSES THE SHARED GENERATOR WITHOUT TOUCHING IT
// --------------------------------------------------------
// We do NOT edit generateFromSource / generatePlan / prompt.ts. Instead we
// compose the build-in-public framing into the inputs that the existing
// machinery already accepts:
//
//   1. We wrap the founder's raw paste in a short framing preamble before
//      handing it to fetchSource()/extractFromSource() — so the extracted
//      themes/quotes/facts are already build-in-public-shaped (e.g. ships,
//      metrics, lessons) rather than generic article material.
//
//   2. We pass a `retryNote` into generateFromSource(). The shared planner
//      threads retryNote verbatim into the user prompt under a dedicated
//      "read carefully" section (see planUserPrompt). It's the cleanest
//      existing seam for an explicit angle/voice instruction without adding
//      a new param to the shared types. We use it to say: write in first
//      person, lead with X, no corporate fluff.
//
//   3. We order channelMix X-first and bias cadence toward X so the lead
//      channel for build-in-public is X.
//
// Persistence mirrors /sources/[id]/actions.ts (idea→variants fan-out, every
// post carries source_id), and we redirect to /plans/[id] — the same success
// destination the normal source→plan flow lands on.

const VOICE_SCORE_THRESHOLD = 70;

export type BuildInPublicState = { error: string | null };

const formSchema = z.object({
  updates: z
    .string()
    .trim()
    .min(50, "Paste at least 50 characters of build updates.")
    .max(60_000, "That’s a lot — trim to the most relevant 60k characters."),
});

// Build-in-public cadence. X leads; the rest fall in behind it. Lower than a
// continuous calendar — this is one focused week from one brain-dump.
const BUILD_IN_PUBLIC_CADENCE: Record<ChannelId, number> = {
  x: 5,
  bluesky: 3,
  threads: 3,
  linkedin: 2,
  instagram: 1,
  facebook: 1,
  tiktok: 1,
  youtube: 1,
};

// The framing we prepend to the founder's raw updates before extraction. This
// shapes the *extraction* toward build-in-public material (ships, metrics,
// lessons learned) — the planner-side instruction lives in BUILD_IN_PUBLIC_NOTE.
function frameSourceText(updates: string): string {
  return [
    "These are a solo founder's raw build-in-public updates — what they shipped, ",
    "fixed, learned, and the numbers they hit while building their product in public. ",
    "Pull out the concrete ships, the real metrics, the hard-won lessons, and any ",
    "honest founder asides — these become authentic build-in-public posts. Keep the ",
    "founder's own phrasing where it's already punchy.",
    "\n\n--- Raw build updates ---\n",
    updates,
  ].join("");
}

// The angle/voice instruction we inject via the planner's `retryNote` seam.
const BUILD_IN_PUBLIC_NOTE = [
  "ANGLE: build-in-public. These ideas come from a solo founder's raw build updates.",
  "Write authentic build-in-public posts in FIRST PERSON (\"I shipped…\", \"I spent two days…\").",
  "Lead with X — it is the primary channel for this audience; make the X variant the strongest,",
  "tightest version of each idea and never skip X unless the idea is genuinely impossible to fit in 280 chars.",
  "Be specific and honest: real numbers, real bugs, real lessons. Show the work and the struggle, not just wins.",
  "No corporate fluff, no \"we're excited to announce\", no growth-hacker hype. Sound like a maker talking to other makers.",
  "Vary the shape across the week: a ship update, a metric, a lesson, a behind-the-scenes, an honest struggle.",
].join("\n");

export async function buildInPublicAction(
  _prev: BuildInPublicState,
  formData: FormData,
): Promise<BuildInPublicState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();

  const parsed = formSchema.safeParse({ updates: formData.get("updates") ?? "" });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const supabase = await supabaseServer();

  // Load the brief + connected channels up front. Both are prerequisites; we
  // bail before burning a Claude extraction call if either is missing.
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);

  if (!briefRes.data) {
    return { error: "Add a brand brief first so we can nail your voice." };
  }

  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return { error: "Connect at least one channel (X works best) before generating." };
  }

  // Build channelMix X-first so the lead channel for build-in-public is X.
  const accountByChannel = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);
  const orderedAccounts = [...accounts].sort((a, b) => {
    if (a.channel === "x") return -1;
    if (b.channel === "x") return 1;
    return 0;
  });
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> =
    orderedAccounts.map((a) => {
      const ch = a.channel as ChannelId;
      return { channel: ch, handle: a.handle, posts_per_week: BUILD_IN_PUBLIC_CADENCE[ch] ?? 3 };
    });

  // Quota check — assume one week of generations.
  const estimatedPosts = channelMix.reduce((sum, c) => sum + c.posts_per_week, 0);
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) return { error: err.message };
    throw err;
  }

  // Step 1 — wrap the raw paste in the build-in-public framing, then run the
  // shared paste→extract pipeline. fetchSource enforces the min-length floor.
  let raw;
  try {
    raw = await fetchSource({
      mode: "paste",
      text: frameSourceText(parsed.data.updates),
      title: "Build-in-public updates",
    });
  } catch (err) {
    if (err instanceof ColdSourceError) {
      return { error: "Add a couple more updates — we need a bit more to work with." };
    }
    return { error: err instanceof Error ? err.message : "Could not read your updates." };
  }

  let extracted;
  try {
    const result = await extractFromSource(raw);
    extracted = result.extracted;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not process your updates." };
  }

  // Step 2 — persist a sources row (RLS-scoped to the workspace member). This
  // mirrors ingestSourceAction so the build-in-public flow shows up in the
  // sources list and posts can attribute back via source_id.
  const insertPayload = {
    workspace_id: ws.id,
    source_kind: raw.kind,
    source_url: raw.sourceUrl,
    file_path: raw.filePath,
    title: extracted.title ?? "Build-in-public updates",
    extracted_summary: extracted.summary,
    extracted_quotes: extracted.quotes as unknown as Json,
    extracted_themes: extracted.themes as unknown as Json,
    extracted_facts: extracted.facts as unknown as Json,
    ingested_by: user.id,
  };
  const { data: sourceRow, error: insertErr } = await supabase
    .from("sources")
    .insert(insertPayload)
    .select("*")
    .single();
  if (insertErr || !sourceRow) {
    return { error: insertErr?.message ?? "Failed to save your updates." };
  }

  // Step 3 — generate the plan. Reuse the shared source→plan generator and
  // inject the build-in-public angle through the existing `retryNote` seam
  // (threaded verbatim into the planner's user prompt). No shared-lib edits.
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
      retryNote: BUILD_IN_PUBLIC_NOTE,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Generation failed — try again." };
  }

  // Step 4 — persist plan + posts. Mirrors the idea→variants fan-out in
  // /sources/[id]/actions.ts; every post carries source_id.
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
    return { error: planErr?.message ?? "Failed to save the plan." };
  }

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
        source_id: sourceRow.id,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          source_id: sourceRow.id,
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: "We only wrote posts for channels you haven’t connected. Connect X and retry." };
  }

  const gatedPayload = await gateBatchForDedup(ws.id, postsPayload);

  const { error: postsErr } = await svc.from("posts").insert(gatedPayload);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message };
  }

  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  revalidatePath("/sources");
  if (skipped.length > 0) {
    console.warn("Build-in-public dropped posts for unconnected channels:", skipped);
  }
  redirect(`/plans/${planRow.id}`);
}

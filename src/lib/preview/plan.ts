// Preview-plan generator. Wraps the workspace-aware `generatePlan` from
// `src/lib/plan/generate.ts` and feeds it a synthetic Brief so anonymous
// visitors get a 1-week, 5-7 post teaser without ever touching the
// brand_briefs table.
//
// This file lives in `src/lib/preview/*` (not `src/lib/plan/*`) so the
// authenticated planner code is untouched.

import type { Database } from "@/lib/db/types";
import { generatePlan } from "@/lib/plan/generate";
import type { GeneratedPlan } from "@/lib/plan/schema";
import type { ChannelId } from "@/lib/channels/registry";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface PreviewInputs {
  /** Channel the visitor entered + handle for prompt context. */
  channel: ChannelId;
  handle: string;
  /** Raw posts (scraped OR pasted) used as voice exemplars. */
  posts: string[];
  /** Optional product/niche hint inferred from the form. */
  niche_hint?: string;
}

export interface PreviewResult {
  plan: GeneratedPlan;
  voice_summary: string;
}

/**
 * Produce a 1-week teaser plan plus a short voice summary string.
 *
 * - 1 week, 5-7 posts (we ask the planner for 6/week on the chosen channel).
 * - Voice exemplars: up to 20 posts from the visitor.
 * - Voice summary: a deterministic string we render alongside the plan
 *   ("AI-extracted from N posts on @handle"). Not a full VoiceProfile —
 *   keeping this lightweight avoids replicating the Phase 1 voice schema
 *   which doesn't exist as a module in this repo yet (reference_posts feed
 *   the planner directly today).
 */
export async function previewPlan(inputs: PreviewInputs): Promise<PreviewResult> {
  const posts = inputs.posts.map((p) => p.trim()).filter(Boolean).slice(0, 20);
  if (posts.length === 0) {
    throw new Error("previewPlan: at least one post is required.");
  }

  const niche = (inputs.niche_hint ?? "").trim();
  const productDescription =
    niche.length > 0
      ? `Inferred from @${inputs.handle} on ${inputs.channel}: ${niche}`
      : `An independent creator/maker active on ${inputs.channel} as @${inputs.handle}. Niche inferred from their writing samples below.`;

  const brief = synthBrief({
    handle: inputs.handle,
    channel: inputs.channel,
    productDescription,
    referencePosts: posts,
  });

  // Aim for 6 posts so a 5-7 teaser slice always has room. The planner
  // returns the agreed-on cadence and we slice to 7 before signing.
  const startDate = new Date();
  const result = await generatePlan({
    brief,
    channelMix: [
      { channel: inputs.channel, handle: inputs.handle, posts_per_week: 6 },
    ],
    weeks: 1,
    startDate,
  });

  const trimmed: GeneratedPlan = {
    ...result.plan,
    posts: result.plan.posts.slice(0, 7),
  };
  return {
    plan: trimmed,
    voice_summary: buildVoiceSummary(posts, inputs.handle, inputs.channel),
  };
}

interface SynthBriefOpts {
  handle: string;
  channel: ChannelId;
  productDescription: string;
  referencePosts: string[];
}

/**
 * Build an in-memory Brief Row. Never persisted. workspace_id is a stable
 * sentinel UUID so the synthetic value is recognisable in logs if it ever
 * leaked, but generatePlan never writes anywhere.
 */
function synthBrief(opts: SynthBriefOpts): Brief {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspace_id: "00000000-0000-0000-0000-0000000000ff", // sentinel; never written.
    product_description: opts.productDescription,
    voice: [
      `Match the register of @${opts.handle} on ${opts.channel}.`,
      "Use phrasing, cadence, vocabulary, and openers that mirror the reference posts below.",
      "Don't sound like generic marketing copy. Don't introduce buzzwords or hype that isn't in the samples.",
    ].join(" "),
    target_audience:
      "Inferred from the reference posts. If unclear, write to the same audience the reference posts implicitly address.",
    do_not_say: [
      "generic AI marketing-speak",
      "leverage",
      "synergy",
      "game-changer",
      "revolutionize",
    ],
    reference_links: [],
    reference_posts: opts.referencePosts,
    voice_profile: null,
    voice_profile_extracted_at: null,
    pending_voice_diff: null,
    pending_voice_diff_at: null,
    created_at: now,
    updated_at: now,
  };
}

function buildVoiceSummary(posts: string[], handle: string, channel: ChannelId): string {
  const n = posts.length;
  const avg = Math.round(posts.reduce((sum, p) => sum + p.length, 0) / n);
  const totalWords = posts.reduce((sum, p) => sum + p.split(/\s+/).length, 0);
  const avgWords = Math.round(totalWords / n);
  return `Voice profile extracted from ${n} ${channel} post${n === 1 ? "" : "s"} by @${handle}. Average ${avgWords} words / ${avg} chars per post.`;
}

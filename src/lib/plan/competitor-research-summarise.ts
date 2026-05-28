// Phase 7 — Summarise branch.
//
// When the workspace already has watch_handles for a channel, we skip
// web search entirely and synthesise patterns from the existing
// competitor_posts cache (populated by the daily cron).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import {
  client,
  extractAndValidate,
  MODEL,
  SUBMIT_TOOL,
  SUBMIT_TOOL_NAME,
  SUMMARISE_SAMPLE_LIMIT,
  truncate,
  type Brief,
  type CompetitorInsight,
} from "./competitor-research-shared";

export interface SummariseInputs {
  channel: ChannelId;
  brief: Brief;
  workspaceId: string;
  handleIds: string[];
  handles: Array<{ handle: string; display_name: string | null }>;
  supabase: SupabaseClient<Database>;
}

export async function summariseFromCache(
  inputs: SummariseInputs,
): Promise<CompetitorInsight | null> {
  const { channel, brief, workspaceId, handleIds, handles, supabase } = inputs;

  const sixtyDaysAgo = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: posts, error: postsErr } = await supabase
    .from("competitor_posts")
    .select("text, pattern_tags, pattern_reason, engagement_rate, posted_at")
    .eq("workspace_id", workspaceId)
    .in("watch_handle_id", handleIds)
    .eq("is_winner", true)
    .gt("posted_at", sixtyDaysAgo)
    .order("engagement_rate", { ascending: false, nullsFirst: false })
    .order("posted_at", { ascending: false })
    .limit(SUMMARISE_SAMPLE_LIMIT);
  if (postsErr) {
    console.warn(
      `Competitor research: failed to load competitor_posts for ${channel}:`,
      postsErr.message,
    );
    return null;
  }
  const winners = posts ?? [];
  if (winners.length === 0) {
    return null;
  }

  const system = [
    "You are a competitive-research analyst for marketingmagic.",
    "Given a brand brief and a list of recent winning posts from a workspace's",
    "watched competitors on a single channel, synthesise:",
    "- 3–5 short structural patterns common across winners",
    "- 3–5 representative sample posts (verbatim text) with a hedged 'possibly worked because…' note",
    "- 3–5 short kebab-case theme tags the brand could lean into on this channel",
    "- One paragraph of reasoning describing what wins on this channel right now",
    "",
    "Rules:",
    "- Describe POSTS and PATTERNS, never authors. Do not name handles in the output.",
    "- Quotes are verbatim. Do not paraphrase.",
    "- Themes are reusable short tags (e.g. 'build-progress', 'before-after-numbers').",
    "- Never adversarial. We are learning structure, not attacking creators.",
    "- Call submit_competitor_insight exactly once.",
  ].join("\n");

  const user = buildSummariseUser(channel, brief, winners);

  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      tools: [SUBMIT_TOOL],
      tool_choice: { type: "tool", name: SUBMIT_TOOL_NAME },
      messages: [{ role: "user", content: user }],
    });
    const parsed = extractAndValidate(response);
    if (!parsed) return null;
    return {
      channel,
      ...parsed,
      discoveredHandles: handles.map((h) => ({
        handle: h.handle,
        display_name: h.display_name,
        source: "existing" as const,
        rationale: null,
      })),
    };
  } catch (err) {
    console.warn(
      `Competitor research: summarise call failed for ${channel}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function buildSummariseUser(
  channel: ChannelId,
  brief: Brief,
  winners: Array<{
    text: string;
    pattern_tags: string[] | null;
    pattern_reason: string | null;
    engagement_rate: number | null;
    posted_at: string;
  }>,
): string {
  const channelLabel = CHANNELS[channel].label;
  const lines: string[] = [];
  lines.push(`## Brand brief`);
  lines.push(`Product: ${brief.product_description}`);
  lines.push(`Audience: ${brief.target_audience}`);
  lines.push(`Voice: ${brief.voice}`);
  lines.push("");
  lines.push(`## Channel`);
  lines.push(channelLabel);
  lines.push("");
  lines.push(
    `## ${winners.length} recent winning posts from this workspace's watched ${channelLabel} competitors`,
  );
  winners.forEach((w, i) => {
    const tags = (w.pattern_tags ?? []).join(", ") || "—";
    const engagement =
      w.engagement_rate !== null
        ? `${(w.engagement_rate * 100).toFixed(2)}%`
        : "n/a";
    lines.push("");
    lines.push(`### Post ${i + 1} — engagement ${engagement} — tags: ${tags}`);
    lines.push(truncate(w.text.replace(/\s+/g, " "), 800));
    if (w.pattern_reason) lines.push(`(Prior note: ${w.pattern_reason})`);
  });
  lines.push("");
  lines.push(
    "Synthesise the patterns + sample posts + theme suggestions + one-paragraph reasoning. Call submit_competitor_insight once.",
  );
  return lines.join("\n");
}

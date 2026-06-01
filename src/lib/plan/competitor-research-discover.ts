// Phase 7 — Discovery branch.
//
// When the workspace has no watch_handles for a channel, we use Anthropic's
// web_search server tool to find top creators in the brand's niche, then
// persist them back into watch_handles so the daily cron picks them up.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, CompetitorWatchChannel } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { isCompetitorChannelSupported } from "@/lib/competitors/schema";
import {
  client,
  extractAndValidate,
  isValidHandle,
  MODEL,
  normaliseHandle,
  SUBMIT_TOOL,
  WEB_SEARCH_MAX_USES,
  type Brief,
  type CompetitorInsight,
} from "./competitor-research-shared";

export interface DiscoverInputs {
  channel: ChannelId;
  brief: Brief;
  workspaceId: string;
  supabase: SupabaseClient<Database>;
}

export async function discoverAndInsightFor(
  inputs: DiscoverInputs,
): Promise<CompetitorInsight | null> {
  const { channel, brief, workspaceId, supabase } = inputs;
  const channelLabel = CHANNELS[channel].label;

  const system = [
    "You are a competitive-research analyst for marketingmagic.",
    `Your job: identify the top creators producing high-engagement content on ${channelLabel}`,
    "in the brand's niche, then synthesise what's working RIGHT NOW into structural patterns,",
    "sample posts, theme tags, and a one-paragraph reasoning block.",
    "",
    "Process:",
    "1. Use web_search to find 3–7 top creators on this specific channel in the brand's niche.",
    "2. For each, find 2–4 recent high-engagement posts.",
    "3. Synthesise patterns, themes, and a paragraph describing what wins on this channel today.",
    "4. Populate discoveredHandles with normalised handle strings (lowercase, NO leading @) and",
    "   a one-line rationale for each.",
    "5. Call submit_competitor_insight exactly once when done.",
    "",
    "Rules:",
    "- Describe posts and patterns. Do NOT name handles inside topPatterns / samplePosts / reasoning.",
    "- The handles list goes ONLY in discoveredHandles.",
    "- Quotes in samplePosts are verbatim. Do not paraphrase.",
    "- Themes are reusable short tags.",
    "- Never adversarial. Describe structure, not personalities.",
  ].join("\n");

  const user = [
    "## Brand brief",
    `Product: ${brief.product_description}`,
    `Audience: ${brief.target_audience}`,
    `Voice: ${brief.voice}`,
    "",
    `## Channel to research: ${channelLabel}`,
    "",
    `Research what's working on ${channelLabel} for this brand's niche. Use web_search to find creators and their recent high-engagement posts, then call submit_competitor_insight.`,
  ].join("\n");

  // SDK 0.39.0 doesn't type the web_search_20250305 server tool; cast through
  // unknown to bypass the static type while keeping the runtime contract.
  const tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES },
    SUBMIT_TOOL,
  ] as unknown as Anthropic.ToolUnion[];

  let response;
  try {
    response = await client().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      tools,
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    console.warn(
      `Competitor research: discovery call failed for ${channel}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const parsed = extractAndValidate(response);
  if (!parsed) return null;

  // Normalise + validate. Invalid handles are dropped from BOTH the upsert
  // path AND the discoveredHandles surfaced to the planner — keeping Unicode
  // garbage out of watch_handles (where the daily cron would crash) and out
  // of the LLM context.
  const discoveredHandles = parsed.discoveredHandles
    .map((h) => {
      const original = h.handle;
      const normalised = normaliseHandle(original);
      if (!normalised || !isValidHandle(normalised, channel)) {
        console.warn(
          "Competitor research: dropped invalid handle:",
          original,
          channel,
        );
        return null;
      }
      return {
        handle: normalised,
        display_name: h.display_name ?? null,
        source: "discovered" as const,
        rationale: h.rationale ?? null,
      };
    })
    .filter((h): h is NonNullable<typeof h> => h !== null);

  // Persist freshly discovered handles. Conflict on
  // (workspace_id, channel, handle) → do nothing — matches the existing
  // unique constraint and keeps this best-effort.
  //
  // watch_handles.channel is the CompetitorWatchChannel DB enum, which does
  // NOT include facebook — competitor-watch isn't wired for Facebook Pages.
  // Discovery research above still runs and feeds the planner; we just skip
  // persisting the handles for channels the watch table can't store.
  if (discoveredHandles.length > 0 && isCompetitorChannelSupported(channel as CompetitorWatchChannel)) {
    const watchChannel = channel as CompetitorWatchChannel;
    try {
      const rows = discoveredHandles.map((h) => ({
        workspace_id: workspaceId,
        channel: watchChannel,
        handle: h.handle,
        display_name: h.display_name,
        status: "active" as const,
      }));
      const { error: upsertErr } = await supabase
        .from("watch_handles")
        .upsert(rows, {
          onConflict: "workspace_id,channel,handle",
          ignoreDuplicates: true,
        });
      if (upsertErr) {
        console.warn(
          `Competitor research: watch_handles upsert failed for ${channel}:`,
          upsertErr.message,
        );
      }
    } catch (err) {
      console.warn(
        `Competitor research: watch_handles persist threw for ${channel}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    channel,
    topPatterns: parsed.topPatterns,
    samplePosts: parsed.samplePosts,
    recommendedThemes: parsed.recommendedThemes,
    reasoning: parsed.reasoning,
    discoveredHandles,
  };
}

// Phase 7 — Live competitor research, fed into plan generation.
//
// User opt-in (via the "Compare what competitors are doing" checkbox). When
// enabled, we run a per-channel research pass that either summarises the
// workspace's existing watch_handles + competitor_posts cache OR (when the
// workspace has none for a given channel) auto-discovers top performers in
// the brand's niche via Anthropic's web_search server tool, then persists
// the discoveries back into watch_handles so the daily cron picks them up.
//
// Failure is contained: any exception in this module produces an empty
// CompetitorInsight[] — plan generation MUST keep flowing. We log warnings
// with the "Competitor research:" prefix for grep-ability in prod logs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, CompetitorWatchChannel } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";
import { type Brief, type CompetitorInsight } from "./competitor-research-shared";
import { summariseFromCache } from "./competitor-research-summarise";
import { discoverAndInsightFor } from "./competitor-research-discover";

export type { CompetitorInsight } from "./competitor-research-shared";

// Per-channel hard timeout (ms). Web search + LLM round-trip should
// complete inside this; if it doesn't, we abort the channel and move on.
const PER_CHANNEL_TIMEOUT_MS = 30_000;
// Aggregate ceiling across all channels. On expiry we surface whatever
// already settled and drop in-flight work. Plan generation continues.
const AGGREGATE_TIMEOUT_MS = 45_000;

export interface ResearchInputs {
  workspaceId: string;
  brief: Brief;
  channels: ChannelId[];
  supabase: SupabaseClient<Database>;
}

export async function researchCompetitorsLive(
  inputs: ResearchInputs,
): Promise<CompetitorInsight[]> {
  try {
    if (!inputs.brief || !inputs.brief.product_description?.trim()) {
      console.warn(
        "Competitor research: skipping — brand brief missing product description.",
      );
      return [];
    }
    const channels = Array.from(new Set(inputs.channels));
    if (channels.length === 0) return [];

    const perChannel = channels.map((channel) =>
      withTimeout(
        researchOneChannel({ channel, ...inputs }),
        PER_CHANNEL_TIMEOUT_MS,
        `channel ${channel}`,
      ).catch((err) => {
        console.warn(
          `Competitor research: channel ${channel} failed:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }),
    );

    const aggregate = Promise.all(perChannel);
    const timeoutPromise = new Promise<(CompetitorInsight | null)[]>((resolve) => {
      setTimeout(() => resolve([]), AGGREGATE_TIMEOUT_MS).unref?.();
    });
    const settled = await Promise.race([aggregate, timeoutPromise]);
    return settled.filter((x): x is CompetitorInsight => x !== null);
  } catch (err) {
    console.warn(
      "Competitor research: unrecoverable error, returning empty insights:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

interface PerChannelInputs extends ResearchInputs {
  channel: ChannelId;
}

async function researchOneChannel(
  inputs: PerChannelInputs,
): Promise<CompetitorInsight | null> {
  const { workspaceId, channel, supabase, brief } = inputs;

  const { data: handles, error: handlesErr } = await supabase
    .from("watch_handles")
    .select("id, handle, display_name")
    .eq("workspace_id", workspaceId)
    // watch_handles.channel is the CompetitorWatchChannel enum (no facebook).
    // For unsupported channels this simply returns no rows → discovery path.
    .eq("channel", channel as CompetitorWatchChannel)
    .eq("status", "active");
  if (handlesErr) {
    console.warn(
      `Competitor research: failed to load watch_handles for ${channel}:`,
      handlesErr.message,
    );
  }

  const handleRows = handles ?? [];
  if (handleRows.length > 0) {
    return summariseFromCache({
      channel,
      brief,
      workspaceId,
      handleIds: handleRows.map((h) => h.id),
      handles: handleRows.map((h) => ({
        handle: h.handle,
        display_name: h.display_name,
      })),
      supabase,
    });
  }

  return discoverAndInsightFor({ channel, brief, workspaceId, supabase });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms (${label})`)),
      ms,
    );
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

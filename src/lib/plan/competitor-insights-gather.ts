import type { SupabaseClient } from "@supabase/supabase-js";
import {
  researchCompetitorsLive,
  type CompetitorInsight,
} from "./competitor-research";
import type { ChannelId } from "@/lib/channels/registry";
import type { Database } from "@/lib/db/types";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface GatherInsightsArgs {
  formData: FormData;
  workspaceId: string;
  brief: Brief;
  channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }>;
  supabase: SupabaseClient<Database>;
}

// Phase 7 — shared "Compare what competitors are doing" wiring for the two
// plan-generation server actions. researchCompetitorsLive() already swallows
// its own failures and returns [], so we deliberately do NOT add another
// try/catch here — any throw from inside would be a programmer error worth
// surfacing.
export async function gatherCompetitorInsights(
  args: GatherInsightsArgs,
): Promise<CompetitorInsight[] | undefined> {
  const compareCompetitors = Boolean(args.formData.get("compare_competitors"));
  if (!compareCompetitors) return undefined;

  const channelsToScan = Array.from(new Set(args.channelMix.map((c) => c.channel)));
  const researched = await researchCompetitorsLive({
    workspaceId: args.workspaceId,
    brief: args.brief,
    channels: channelsToScan,
    supabase: args.supabase,
  });
  return researched.length > 0 ? researched : undefined;
}

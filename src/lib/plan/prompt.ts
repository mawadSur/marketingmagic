import type { Database } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface ThemeSignal {
  theme: string;
  engagement_rate: number | null;
  sample_size: number;
}

export interface PlanGenInputs {
  brief: Brief;
  channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }>;
  weeks: number;
  startDate: Date;
  winners?: ThemeSignal[];
  losers?: ThemeSignal[];
}

function windowSummary(channel: ChannelId): string {
  const spec = CHANNELS[channel];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const parts = spec.recommendedWindows.map((w) => {
    const dayName = days[w.weekday - 1];
    const ranges = w.ranges.map(([a, b]) => `${a}-${b}`).join(", ");
    return `${dayName} ${ranges}`;
  });
  return parts.join(" · ");
}

// Per-channel hard caps pulled straight from the registry — keep this one
// source of truth. The planner reads these, the zod schema enforces them.
function channelCapsBlock(channels: ChannelId[]): string {
  const lines = channels.map((c) => `- ${CHANNELS[c].label}: ≤ ${CHANNELS[c].maxChars} chars`);
  return lines.join("\n");
}

// Channel-specific tone hints. Brief, opinionated, and aimed at making
// cross-channel adaptation feel like the brand wrote each version itself.
const CHANNEL_TONE: Record<ChannelId, string> = {
  x: "Punchy. One idea, sharp angle. Hook in the first line. No filler.",
  linkedin:
    "Long-form is fine but the hook still goes first. Professional register, no jargon, no emoji unless brand uses them. Paragraphs short.",
  threads:
    "Conversational, low-stakes, reply-bait. Opener should invite a response. Treat like text-message culture.",
  instagram:
    "Image-led — caption supports the visual. First 125 chars carry the hook before the 'more' fold. Hashtags 3-8 only if useful.",
  bluesky:
    "Same energy as X but the audience is more tech/skeptical. No hashtags. Reward specificity over hype.",
};

export function planSystemPrompt(inputs: PlanGenInputs): string {
  const { brief } = inputs;
  const activeChannels = Array.from(new Set(inputs.channelMix.map((c) => c.channel)));

  return [
    "You are the planning brain of marketingmagic, a marketing-automation tool.",
    "Your job: produce a posting plan that sounds like the brand wrote it themselves.",
    "",
    "## Brand brief",
    "",
    "### Product",
    brief.product_description,
    "",
    "### Voice",
    brief.voice,
    "",
    "### Target audience",
    brief.target_audience,
    "",
    brief.do_not_say.length > 0
      ? `### Do NOT say (avoid these words/phrases verbatim)\n${brief.do_not_say.map((w) => `- ${w}`).join("\n")}\n`
      : "",
    brief.reference_links.length > 0
      ? `### Reference links\n${brief.reference_links.map((l) => `- ${l}`).join("\n")}\n`
      : "",
    brief.reference_posts.length > 0
      ? `### Reference posts (voice exemplars — match this register)\n${brief.reference_posts.map((p) => `- ${p}`).join("\n")}\n`
      : "",
    "## Channel constraints",
    ...inputs.channelMix.map(
      (c) => `- ${CHANNELS[c.channel].label} (@${c.handle}): ${CHANNELS[c.channel].promptConstraint}`,
    ),
    "",
    "## Recommended posting windows (local time; bias suggested_scheduled_at toward these)",
    ...inputs.channelMix.map((c) => `- ${CHANNELS[c.channel].label}: ${windowSummary(c.channel)}`),
    "",
    "## Cross-channel adaptation",
    "Each idea fans out into per-channel variants. Don't paste the same text into every channel — adapt the same core message to each channel's voice and length.",
    "",
    "Hard character limits (the tool will reject anything over):",
    channelCapsBlock(activeChannels),
    "",
    "Tone per channel:",
    ...activeChannels.map((c) => `- ${CHANNELS[c].label}: ${CHANNEL_TONE[c]}`),
    "",
    "### When to skip a channel (set `skip: true` on the variant)",
    "- Long-form essay or 5-paragraph teardown → skip X and Bluesky (too long to compress without losing the argument).",
    "- Single-image visual quote or behind-the-scenes shot → skip LinkedIn (caption-led professional context doesn't fit).",
    "- Industry inside-baseball post for engineers → skip Instagram (audience mismatch).",
    "- Time-sensitive announcement that's already passed in another channel's window → skip the late channel.",
    "Always provide a `rationale` either way — \"why this works here\" or \"why this doesn't fit here\".",
    "",
    "## Rules",
    "- Each post must stand on its own. Assume the reader has no prior context.",
    "- Vary themes across the week. Don't repeat the same angle two ideas in a row.",
    "- Concrete > abstract. Numbers, screenshots-of-the-soul beats, specific names.",
    "- No filler. If a post wouldn't justify a reader's 3 seconds, cut it.",
    "- Match the post body to its channel's constraint above. Don't write 280-char copy for a LinkedIn slot or 2000-char copy for X.",
    "- For variants where a visual would amplify the message, include an `image_prompt`:",
    "  a single sentence describing a single image that pairs with the post.",
    "  Keep it concrete and visual (subject, setting, mood, style). No text overlays",
    "  unless the post is specifically about a quoted phrase. Omit `image_prompt`",
    "  entirely for variants where an image would feel forced.",
    "- Output strict JSON matching the schema. No prose outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planUserPrompt(inputs: PlanGenInputs): string {
  // Posts/week is per-channel; for ideas we want roughly the max per-channel
  // cadence (since every idea fans out to every channel). The user prompt
  // expresses both so Claude can balance.
  const maxPostsPerWeek = inputs.channelMix.reduce((m, c) => Math.max(m, c.posts_per_week), 0);
  const totalVariantSlots = inputs.channelMix.reduce(
    (sum, c) => sum + c.posts_per_week * inputs.weeks,
    0,
  );
  const start = inputs.startDate.toISOString().slice(0, 10);

  const kpiNote =
    (inputs.winners?.length ?? 0) > 0 || (inputs.losers?.length ?? 0) > 0
      ? [
          "",
          "## Prior performance (weight your themes accordingly)",
          inputs.winners && inputs.winners.length > 0
            ? `Lean into (top performers):\n${inputs.winners
                .map(
                  (w) =>
                    `- ${w.theme} — engagement ${w.engagement_rate?.toFixed(3) ?? "n/a"} over ${w.sample_size} posts`,
                )
                .join("\n")}`
            : "",
          inputs.losers && inputs.losers.length > 0
            ? `Avoid or reframe (bottom performers):\n${inputs.losers
                .map(
                  (l) =>
                    `- ${l.theme} — engagement ${l.engagement_rate?.toFixed(3) ?? "n/a"} over ${l.sample_size} posts`,
                )
                .join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

  const channelsAllowed = Array.from(new Set(inputs.channelMix.map((c) => c.channel))).join(", ");
  const ideasTarget = maxPostsPerWeek * inputs.weeks;

  return [
    `Generate a ${inputs.weeks}-week posting plan starting ${start}.`,
    "",
    "Cadence (per channel, per week):",
    ...inputs.channelMix.map(
      (c) => `- ${CHANNELS[c.channel].label} (@${c.handle}): ${c.posts_per_week} posts/week`,
    ),
    `Aim for ~${ideasTarget} ideas total (an idea = one piece of content, fanned out across the channels above). Variant slots total ~${totalVariantSlots} — that's the upper bound, not a target; skipping unfit channels is fine and expected.`,
    `Use only these channel values for variants: ${channelsAllowed}.`,
    "",
    "Spread `suggested_scheduled_at` across the window — bias toward the recommended posting windows listed in the system prompt. Use UTC ISO timestamps. The same timestamp applies to all variants of an idea (we'll fan them out per channel windowing later).",
    "Theme tags are free-form labels like build-progress, winner-announcement, voice-thought-piece, behind-the-scenes. Reuse the SAME tag for ideas of the same category so we can measure engagement per theme.",
    kpiNote,
    "",
    "Call the submit_plan tool with the full plan. Do not respond with prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

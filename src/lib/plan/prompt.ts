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

export function planSystemPrompt(inputs: PlanGenInputs): string {
  const { brief } = inputs;
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
    "## Rules",
    "- Each post must stand on its own. Assume the reader has no prior context.",
    "- Vary themes across the week. Don't repeat the same angle two posts in a row.",
    "- Concrete > abstract. Numbers, screenshots-of-the-soul beats, specific names.",
    "- No filler. If a post wouldn't justify a reader's 3 seconds, cut it.",
    "- Match the post body to its channel's constraint above. Don't write 280-char copy for a LinkedIn slot or 2000-char copy for X.",
    "- For posts where a visual would amplify the message, include an `image_prompt`:",
    "  a single sentence describing a single image that pairs with the post.",
    "  Keep it concrete and visual (subject, setting, mood, style). No text overlays",
    "  unless the post is specifically about a quoted phrase. Omit `image_prompt`",
    "  entirely for posts where an image would feel forced.",
    "- Output strict JSON matching the schema. No prose outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planUserPrompt(inputs: PlanGenInputs): string {
  const totalPosts = inputs.channelMix.reduce(
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

  const channelEnumLiteral = Array.from(new Set(inputs.channelMix.map((c) => c.channel)))
    .map((c) => `"${c}"`)
    .join(" | ");

  return [
    `Generate a ${inputs.weeks}-week posting plan starting ${start}.`,
    "",
    "Cadence:",
    ...inputs.channelMix.map(
      (c) => `- ${CHANNELS[c.channel].label} (@${c.handle}): ${c.posts_per_week} posts/week`,
    ),
    `Total posts to produce: ${totalPosts}.`,
    "",
    "Spread `suggested_scheduled_at` across the window — bias toward the recommended posting windows listed in the system prompt. Use UTC ISO timestamps.",
    "Theme tags are free-form labels like \"build-progress\", \"winner-announcement\", \"voice-thought-piece\", \"behind-the-scenes\". Reuse the SAME tag for posts of the same category so we can measure engagement per theme.",
    kpiNote,
    "",
    "Return ONLY JSON in this exact shape:",
    "{",
    '  "plan_name": "string",',
    '  "overview": "string (one-paragraph summary of the angle and rhythm)",',
    '  "posts": [',
    "    {",
    `      "channel": ${channelEnumLiteral},`,
    '      "text": "string",',
    '      "theme": "string",',
    '      "suggested_scheduled_at": "ISO 8601 UTC datetime",',
    '      "rationale": "string (why this post, why this slot)",',
    '      "image_prompt": "string | omit (single sentence describing the paired image)"',
    "    }",
    "  ]",
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

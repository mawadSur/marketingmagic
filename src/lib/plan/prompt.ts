import type { Database, VoiceProfile } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import type { SavedPattern } from "@/lib/explain/playbook";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface ThemeSignal {
  theme: string;
  engagement_rate: number | null;
  sample_size: number;
}

// Phase 1 (Voice Wedge): per-reason aggregates from recent rejections.
// Surfaced in the user prompt as "avoid these patterns."
export interface RejectionSignal {
  reason: "off_voice" | "wrong_theme" | "factually_wrong" | "other";
  count: number;
  // Up to ~3 short snippets of the post text that was rejected with this
  // reason. Optional — the cron may also include reason_note text.
  examples: string[];
}

export interface PlanGenInputs {
  brief: Brief;
  channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }>;
  weeks: number;
  startDate: Date;
  winners?: ThemeSignal[];
  losers?: ThemeSignal[];
  rejections?: RejectionSignal[];
  // Optional: hard signal from the retry loop. When the previous attempt
  // came back low-voice we add a stronger nudge telling Claude *which*
  // patterns to abandon and to score itself more honestly this time.
  retryNote?: string;
  // Patterns the user has explicitly saved from past winner explainer
  // cards. Surfaced verbatim in the system prompt so Claude can lean into
  // them. Loaded from the playbook_patterns table (last 90d, max 12 entries).
  savedPatterns?: SavedPattern[];
}

// Renders a "Preferred patterns from your saved playbook" block. Each line
// is a verbatim summary the user explicitly clicked Save on — these are
// stronger than the auto-detected winner/loser themes because they're a
// human signal that "yes, do more of this." We hedge the framing so
// Claude doesn't ape every saved pattern into every post.
function savedPatternsBlock(patterns: SavedPattern[] | undefined): string {
  if (!patterns || patterns.length === 0) return "";
  const grouped = new Map<string, string[]>();
  for (const p of patterns) {
    const arr = grouped.get(p.pattern_kind) ?? [];
    arr.push(p.summary);
    grouped.set(p.pattern_kind, arr);
  }
  const lines = ["## Preferred patterns from your saved playbook"];
  lines.push(
    "The user has explicitly saved these patterns from past winning posts. Lean into them where natural — do not force every post to satisfy every pattern.",
  );
  for (const [kind, summaries] of grouped.entries()) {
    lines.push(`### ${kind}`);
    for (const s of summaries) lines.push(`- ${s}`);
  }
  return lines.join("\n") + "\n";
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
  const voiceProfile = brief.voice_profile as VoiceProfile | null;
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
    voiceProfile ? voiceProfileBlock(voiceProfile) : "",
    savedPatternsBlock(inputs.savedPatterns),
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
    voiceProfile
      ? "- For EVERY post, include a `voice_score` (0-100) self-assessing match to the voice profile above. Be calibrated — 70 is the threshold below which the post will be auto-regenerated."
      : "",
    "- Output strict JSON matching the schema. No prose outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

function voiceProfileBlock(v: VoiceProfile): string {
  const lines: string[] = [
    "### Voice profile (extracted from the brand's own posts — match this register precisely)",
    "",
    v.summary,
    "",
    `- Vocabulary signature: ${v.vocabulary_signature}`,
    `- Formality: ${v.formality}`,
    `- Emoji usage: ${v.emoji_usage}`,
    `- Average sentence length: ~${v.sentence_length_avg.toFixed(0)} words`,
  ];
  if (v.opener_patterns.length > 0) {
    lines.push(`- Typical openers: ${v.opener_patterns.slice(0, 8).map((s) => `"${s}"`).join(", ")}`);
  }
  if (v.signature_phrases.length > 0) {
    lines.push(
      `- Signature phrases (use these where they fit naturally): ${v.signature_phrases.slice(0, 10).map((s) => `"${s}"`).join(", ")}`,
    );
  }
  if (v.punctuation_quirks.length > 0) {
    lines.push(`- Punctuation quirks: ${v.punctuation_quirks.slice(0, 6).join(", ")}`);
  }
  if (v.do_not_say.length > 0) {
    lines.push(`- Voice anti-patterns (additional do-not-say from profile): ${v.do_not_say.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n") + "\n";
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

  const channelsAllowed = Array.from(new Set(inputs.channelMix.map((c) => c.channel))).join(", ");

  const rejectionNote =
    (inputs.rejections?.length ?? 0) > 0
      ? [
          "",
          "## Recent rejection feedback (do NOT repeat these patterns)",
          ...(inputs.rejections ?? []).map((r) => {
            const label = rejectionReasonLabel(r.reason);
            const examples = r.examples
              .slice(0, 3)
              .map((e) => `  · ${truncate(e, 140)}`)
              .join("\n");
            return `- ${label} (${r.count} recent post${r.count === 1 ? "" : "s"} rejected)${examples ? "\n" + examples : ""}`;
          }),
        ].join("\n")
      : "";

  const retryNote = inputs.retryNote
    ? [
        "",
        "## Retry pass — read carefully",
        inputs.retryNote,
      ].join("\n")
    : "";

  return [
    `Generate a ${inputs.weeks}-week posting plan starting ${start}.`,
    "",
    "Cadence:",
    ...inputs.channelMix.map(
      (c) => `- ${CHANNELS[c.channel].label} (@${c.handle}): ${c.posts_per_week} posts/week`,
    ),
    `Total posts to produce: ${totalPosts}.`,
    `Use only these channel values for each post: ${channelsAllowed}.`,
    "",
    "Spread `suggested_scheduled_at` across the window — bias toward the recommended posting windows listed in the system prompt. Use UTC ISO timestamps.",
    "Theme tags are free-form labels like build-progress, winner-announcement, voice-thought-piece, behind-the-scenes. Reuse the SAME tag for posts of the same category so we can measure engagement per theme.",
    kpiNote,
    rejectionNote,
    retryNote,
    "",
    "Call the submit_plan tool with the full plan. Do not respond with prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

function rejectionReasonLabel(
  r: "off_voice" | "wrong_theme" | "factually_wrong" | "other",
): string {
  switch (r) {
    case "off_voice":
      return "Off-voice (didn't sound like the brand)";
    case "wrong_theme":
      return "Wrong theme (off-strategy for this audience)";
    case "factually_wrong":
      return "Factually wrong (made-up claims, bad numbers)";
    case "other":
      return "Other reasons";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

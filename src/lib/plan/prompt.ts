import type { Database, VoiceProfile } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import type { SavedPattern } from "@/lib/explain/playbook";
import type { ExtractedQuote, ExtractedFact } from "@/lib/sources/schema";
import type { CompetitorInsight } from "@/lib/plan/competitor-research";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

// Phase 2.5: optional source-anchored context. When present, Claude is told
// to ground every idea in this material — themes, quotes, and facts from
// the user-supplied source. The shape is a flat projection of the
// `ExtractedSource` jsonb columns on `sources` so the caller (the source-
// generator) can hand them in without re-fetching.
export interface SourceContext {
  title: string;
  summary: string;
  themes: string[];
  quotes: ExtractedQuote[];
  facts: ExtractedFact[];
  // Free-form pointer the prompt surfaces ("see original article", "see
  // the linked transcript") — purely a Claude-side hint; we never expose
  // this string to the user.
  sourceUrl?: string | null;
}

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
  // Phase 2.5: source-anchored generation. When set, the plan generator
  // produces a "content cluster" rooted in this material — themes from
  // the source bias the planner's theme tags, quotes can be used as hooks,
  // and the system prompt explicitly instructs Claude to ground every
  // idea in the source. When unset, behaviour is unchanged from Phase 2.
  source?: SourceContext;
  // Phase 6.10: per-channel pre-ranked tag suggestions drawn from the
  // workspace's hashtag_usage history. The block this thread renders is
  // hint-only — chips in /queue are the actual recommendation surface.
  // When unset or empty for a channel, the prompt block is skipped.
  hashtagSuggestions?: Map<ChannelId, string[]>;
  // Phase 6A: themes whose 80% credible interval excludes the workspace
  // baseline on the upside. Surfaced verbatim in the system prompt
  // beneath the saved-patterns block. Stronger signal than the
  // collectThemeSignals() winners (which average raw rates) because
  // shrinkage filters out themes that look hot on a tiny sample.
  // Empty array = no statistically-meaningful winners yet — the block
  // is skipped entirely.
  themeWinners?: ThemeWinnerSignal[];
  // Phase 7: live competitor research. One entry per active channel.
  // Set when the user ticked "Compare what competitors are doing" on the
  // plan-generation form. When undefined or empty, the system prompt is
  // unchanged from current behaviour. The research pass is best-effort —
  // failure produces undefined here, never throws into the planner.
  competitorInsights?: CompetitorInsight[];
}

// Phase 6A — single row of the "themes that have been working" block.
// Mirrors `ThemeWinner` from src/lib/analytics/themes.ts but kept as a
// plain shape here to avoid pulling the analytics module into the
// shared prompt types.
export interface ThemeWinnerSignal {
  tag: string;
  posterior_mean: number;
  ci_low: number;
  ci_high: number;
  posts: number;
  lift: number;
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

// Phase 6A: render the "themes that have been working" block. These are
// themes whose 80% credible interval (Beta-Binomial posterior, 28d
// window, decay-weighted) excludes the workspace baseline on the
// upside — i.e. themes shrinkage convinced us are real winners. We hedge
// the framing so Claude leans toward them without aping every winning
// theme into every post; the lift number is informational, not a target.
function themeWinnersBlock(winners: ThemeWinnerSignal[] | undefined): string {
  if (!winners || winners.length === 0) return "";
  const lines: string[] = ["## Themes that have been working"];
  lines.push(
    "These themes are running above this workspace's own baseline at 80% credible-interval confidence over the last 28 days. Lean into them where the idea fits — do not force every idea into a winning theme.",
  );
  for (const w of winners) {
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
    lines.push(
      `- ${w.tag} — posterior ${pct(w.posterior_mean)} engagement (${w.lift.toFixed(2)}× baseline, CI ${pct(w.ci_low)}–${pct(w.ci_high)}, ${w.posts} post${w.posts === 1 ? "" : "s"})`,
    );
  }
  return lines.join("\n") + "\n";
}

// Phase 7: render the "what's working for competitors right now" block.
// Distinct from themeWinnersBlock (which reflects this workspace's own
// historical engagement) — these insights are external signal pulled
// live from competitor research. We hedge the framing so Claude treats
// them as directional hints, not templates to copy; the brief and voice
// profile still override anything here. "Do not paraphrase" sample posts
// is enforced inline — the existing voice/quotes guardrails carry the rest.
function competitorInsightsBlock(insights: CompetitorInsight[] | undefined): string {
  if (!insights || insights.length === 0) return "";
  const lines: string[] = ["## What's working for competitors right now"];
  lines.push(
    "Live research on top performers in each channel. Treat these as directional hints — patterns to consider, not templates to copy. Voice rules and the brand brief still override anything here.",
  );
  for (const ins of insights) {
    const label = CHANNELS[ins.channel].label;
    lines.push("");
    lines.push(`### ${label}`);
    lines.push(ins.reasoning);
    if (ins.topPatterns.length > 0) {
      lines.push("");
      lines.push("Patterns observed:");
      for (const p of ins.topPatterns) lines.push(`- ${p}`);
    }
    if (ins.recommendedThemes.length > 0) {
      lines.push("");
      lines.push(
        `Themes trending on this channel (consider as theme tags): ${ins.recommendedThemes.join(", ")}`,
      );
    }
    if (ins.samplePosts.length > 0) {
      lines.push("");
      lines.push("Sample posts (for pattern reference — do NOT paraphrase):");
      for (const s of ins.samplePosts) {
        lines.push(`- "${s.text}" — ${s.why_it_worked}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Phase 2.5: render the source material block. The planner is told this
// is the *anchor* for every idea — not background context — so every
// generated post should be traceably grounded in one or more of the items
// below. Quotes are wrapped in quote marks verbatim; the planner instruction
// elsewhere in the prompt forbids paraphrasing them when used as hooks.
function sourceBlock(src: SourceContext | undefined): string {
  if (!src) return "";
  const lines: string[] = [];
  lines.push("## Source material (anchor every idea in this)");
  lines.push(
    "The user pasted or fetched this source and is asking for a content cluster built from it. " +
      "Every idea in the plan must be grounded in one or more themes / quotes / facts below — " +
      "do not invent material the source doesn't support. When you quote, use the quote verbatim " +
      "(no paraphrasing). When the source contains quotable phrases — especially the customer's own " +
      "words, voice-memo asides, or off-script lines — preserve them verbatim as hook lines or " +
      "punchlines when natural. Don't paraphrase what's already well-said.",
  );
  lines.push("");
  lines.push(`### Title: ${src.title}`);
  if (src.sourceUrl) lines.push(`Source URL: ${src.sourceUrl}`);
  lines.push("");
  lines.push("### Summary");
  lines.push(src.summary);
  if (src.themes.length > 0) {
    lines.push("");
    lines.push("### Themes (lean on these as theme tags — reuse the exact label)");
    for (const t of src.themes) lines.push(`- ${t}`);
  }
  if (src.quotes.length > 0) {
    lines.push("");
    lines.push("### Quotes (verbatim — use as hooks where they fit naturally)");
    for (const q of src.quotes) {
      const attrib = q.speaker ? ` — ${q.speaker}` : "";
      lines.push(`- "${q.text}"${attrib}`);
    }
  }
  if (src.facts.length > 0) {
    lines.push("");
    lines.push("### Facts (concrete claims — use these instead of inventing numbers)");
    for (const f of src.facts) {
      const ctx = f.context ? ` (${f.context})` : "";
      lines.push(`- ${f.text}${ctx}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────
// Phase 6.10 hashtag — recommendedHashtagsBlock
// ─────────────────────────────────────────────────────────────
//
// Render a per-channel hint section ONLY when the caller hands in a
// non-empty `hashtagSuggestions`. Deliberately minimal: tag names + the
// per-channel policy line. We do not pass confidence scores — the
// recommender already capped and ranked, and Claude shouldn't pretend
// to re-rank on numbers it can't verify.
//
// The instruction is "may use" not "must use" — Phase 6.10 is
// recommendation-only and the /queue chip UI is the binding contract.
// This block exists so generated drafts already align with the chips
// instead of requiring the user to add tags by hand.
function recommendedHashtagsBlock(
  suggestions: Map<ChannelId, string[]> | undefined,
  activeChannels: ChannelId[],
): string {
  if (!suggestions || suggestions.size === 0) return "";
  const lines: string[] = ["## Hashtag hints (recommendation-only — do not over-tag)"];
  lines.push(
    "These tags come from this workspace's own engagement history. Use them where they fit the post naturally. Channel-specific caps are HARD — never exceed them, and prefer fewer tags over more.",
  );
  // Cap copy (mirrors src/lib/hashtags/rules.ts).
  const CAP_COPY: Record<ChannelId, string> = {
    x: "X: 0–1 tags. Default is no tag — the algorithm penalizes spam.",
    linkedin: "LinkedIn: exactly 3 niche tags. Audience-specific beats mega-broad.",
    threads: "Threads: 1–2 conversational tags.",
    instagram: "Instagram: 8–15 mixed-tier tags (mega + mid + niche).",
    bluesky: "Bluesky: NO hashtags. Skip entirely.",
    facebook: "Facebook: 0–2 tags. Hashtags add little on a Page — default to none unless load-bearing.",
  };
  for (const ch of activeChannels) {
    const tags = suggestions.get(ch) ?? [];
    if (ch === "bluesky") {
      // Always emit the explicit "no tags" rule on Bluesky so a stray
      // historical tag in another channel can't bleed into a Bluesky variant.
      lines.push(`- ${CHANNELS[ch].label}: ${CAP_COPY[ch]}`);
      continue;
    }
    if (tags.length === 0) {
      lines.push(`- ${CHANNELS[ch].label}: ${CAP_COPY[ch]} (no workspace history yet — pick tags only if they fit the prose)`);
      continue;
    }
    lines.push(
      `- ${CHANNELS[ch].label}: ${CAP_COPY[ch]} Candidate tags from history: ${tags
        .map((t) => `#${t}`)
        .join(" ")}`,
    );
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
  facebook:
    "Conversational and community-oriented. Lead with the hook; keep it to 1–2 short paragraphs with one clear CTA. Hashtags sparing.",
};

// LinkedIn long-form guidance — emitted only when LinkedIn is in the active
// channel mix. Cross-channel variants tend to collapse into "X-with-more-
// characters" by default: Claude takes the X-shape draft, tacks on a
// transition phrase + a CTA, and ships that as the LinkedIn variant. The
// 3000-char cap is then wasted on a 250-char tweet in a suit. This block
// nudges Claude to use the room when the *idea* has depth, while leaving
// genuine one-beat ideas alone (the schema stays permissive — guidance
// lives here, not in zod).
function linkedinLongFormBlock(active: ChannelId[]): string {
  if (!active.includes("linkedin")) return "";
  return [
    "## LinkedIn long-form guidance",
    "LinkedIn is NOT 'X with more characters.' Treat it as a different format, not a longer one.",
    "- When the idea has substance — a thesis, a story, multiple supporting points, a contrarian frame, a teardown — use 800–2500 characters. Develop the argument; LinkedIn rewards depth.",
    "- Stay under ~600 characters ONLY when the idea is genuinely one-beat: a single quote, a single observation, a single ask. If you stay short, say so in the variant `rationale` (e.g. \"one-beat observation, no padding warranted\").",
    "- Structure matters: open with a 1–2 line hook, develop with short paragraphs / numbered points / bullets, close with a takeaway or a question that invites a comment.",
    "- Do NOT pad. If the idea is one beat, do not stretch it with filler transitions, recap sentences, or generic CTAs to hit a length target.",
    "- Voice rules still apply — voice_profile (formality, openers, signature phrases) carries through. The LinkedIn variant should sound like the same brand, just with more room to breathe.",
    "",
  ].join("\n");
}

export function planSystemPrompt(inputs: PlanGenInputs): string {
  const { brief } = inputs;
  const voiceProfile = brief.voice_profile as VoiceProfile | null;
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
    voiceProfile ? voiceProfileBlock(voiceProfile) : "",
    savedPatternsBlock(inputs.savedPatterns),
    themeWinnersBlock(inputs.themeWinners),
    competitorInsightsBlock(inputs.competitorInsights),
    sourceBlock(inputs.source),
    recommendedHashtagsBlock(inputs.hashtagSuggestions, activeChannels),
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
    linkedinLongFormBlock(activeChannels),
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
    voiceProfile
      ? "- For EVERY variant, include a `voice_score` (0-100) self-assessing match to the voice profile above. Be calibrated — 70 is the threshold below which the post will be auto-regenerated."
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

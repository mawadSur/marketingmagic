import type { Database, VoiceProfile } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import type { SavedPattern } from "@/lib/explain/playbook";
import type { ExtractedQuote, ExtractedFact } from "@/lib/sources/schema";
import type { CompetitorInsight } from "@/lib/plan/competitor-research";
import {
  channelCapsBlock,
  channelToneBlock,
  linkedinLongFormBlock,
} from "@/lib/plan/channel-guidance";

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
  // Phase 8 (dedup wedge): a window of the workspace's own recently-posted
  // and still-queued content, newest first. Surfaced so the planner knows
  // what already exists and stops re-generating the same angles. Collected
  // by src/lib/plan/recent-content.ts (last 45d, ~24 newest). When
  // undefined or empty, the block is skipped.
  recentContent?: RecentContentSignal[];
  // Phase 8: the workspace's best and worst *individual* posts, scored per
  // post (not per theme) against a decay-weighted baseline. Lets the
  // planner lean toward proven shapes and away from flops. Collected by
  // collectPostExemplars() in src/lib/plan/signals.ts. When undefined or
  // empty, the block is skipped.
  postExemplars?: PostExemplar[];
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

// Phase 8 (dedup wedge) — one already-queued-or-posted piece of content,
// projected for the prompt so Claude can avoid repeating itself. The
// planner has historically had no idea what's already sitting in the
// queue, so it would happily re-generate the same five "budgeting tips"
// posts week after week. `snippet` is a short slice of the post text
// (the collector clamps it to ~140 chars); `status` tells Claude whether
// the post already went out or is still waiting in the queue.
export interface RecentContentSignal {
  theme: string | null;
  status: "posted" | "scheduled" | "pending_approval";
  snippet: string;
}

// Phase 8 — a single individual-post exemplar (not a theme aggregate).
// `verdict` is the per-post score from src/lib/feedback/post-performance.ts:
// winners ran well above this workspace's decay-weighted baseline,
// underperformers well below it. `ratio` is engagement_rate / baseline
// (e.g. 2.1 = 2.1× baseline). The text is surfaced verbatim so Claude can
// study the *shape* of what worked — never to copy the words.
export interface PostExemplar {
  verdict: "winner" | "underperformer";
  theme: string | null;
  ratio: number;
  text: string;
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

// AI-generated snippet/text/theme values are user-editable and get
// interpolated raw into the system prompt. A body containing a newline
// followed by "## " would inject a fake heading, and an embedded double-
// quote would break the "..." wrapping we render around snippets. This
// neutralizes all three: collapse every run of whitespace (incl. newlines)
// to a single space, strip leading markdown markers, and remove embedded
// double-quotes so the value renders as one inert line.
function sanitizePromptText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/"/g, "")
    .trim();
}

// Normalize a snippet/text for cross-block dedupe matching: lowercase and
// collapse all whitespace to single spaces so a recentContent snippet that is
// a clamped prefix of (or otherwise contained in) an exemplar can be matched
// robustly via substring containment in either direction.
function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Phase 8 (dedup wedge): render the "already in your queue or recently
// posted" block. This is the planner's memory of what it (or the user)
// has already produced — without it the generator re-writes the same
// handful of angles every week. We lead with a per-theme tally so Claude
// can see at a glance which themes are already saturated, then list the
// newest items so it can avoid colliding with specific posts. The three
// hard rules are the heart of the dedup wedge: new angles only, don't
// pile onto an already-queued theme, and prefer a fresh angle (or, when
// the brief allows, a different theme) over rephrasing what's queued.
export function recentContentBlock(items: RecentContentSignal[] | undefined): string {
  if (!items || items.length === 0) return "";
  const lines: string[] = [
    "## Already in your queue or recently posted — DO NOT REPEAT THESE",
  ];

  // Per-theme tally, ordered most-saturated first (e.g. "budgeting ×5,
  // hiring ×2"). Untagged items are bucketed under "(untagged)" so the
  // count still reflects the real volume.
  const counts = new Map<string, number>();
  for (const it of items) {
    const key = it.theme ? sanitizePromptText(it.theme) : "(untagged)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const tally = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([theme, n]) => `${theme} ×${n}`)
    .join(", ");
  if (tally) lines.push(`Already covered: ${tally}`);

  lines.push("");
  // Up to 24 newest items (the collector already orders newest-first and
  // caps the list, but we clamp again defensively).
  for (const it of items.slice(0, 24)) {
    const theme = it.theme ? sanitizePromptText(it.theme) : "(untagged)";
    lines.push(`- [${it.status}] ${theme} — "${sanitizePromptText(it.snippet)}"`);
  }

  lines.push("");
  lines.push("Hard rules for this block:");
  lines.push(
    "- Only add genuinely NEW angles. If an idea overlaps one above, drop it or attack the topic from a different direction.",
  );
  lines.push(
    "- Don't over-index a theme that's already queued heavily — if a theme appears 4+ times above, prefer a fresh theme over piling on another post.",
  );
  lines.push(
    "- When a theme is saturated, prefer finding a genuinely NEW ANGLE within it (or varying the format) over rephrasing something already in the queue. Only switch to a different theme if the brief allows it.",
  );
  return lines.join("\n") + "\n";
}

// Phase 8: render the "your best and worst individual posts" block. Unlike
// themeWinnersBlock (which aggregates by theme), this surfaces specific
// posts scored per-post against a decay-weighted baseline. Winners teach
// the planner the *shape* that lands for this brand; underperformers show
// the shape to steer clear of. We are emphatic that this is about energy
// and structure, never the words — copying the text verbatim would defeat
// the dedup wedge this batch ships alongside.
export function postExemplarsBlock(items: PostExemplar[] | undefined): string {
  if (!items || items.length === 0) return "";
  const winners = items.filter((e) => e.verdict === "winner");
  const losers = items.filter((e) => e.verdict === "underperformer");
  const lines: string[] = ["## Your best and worst individual posts"];
  if (winners.length > 0) {
    lines.push("");
    lines.push(
      "These landed well above baseline — write more posts shaped like these — same energy, NOT the same words:",
    );
    for (const w of winners) {
      lines.push(`- [${w.ratio.toFixed(1)}× baseline] "${sanitizePromptText(w.text)}"`);
    }
  }
  if (losers.length > 0) {
    lines.push("");
    lines.push("These fell well below baseline — avoid this shape/angle:");
    for (const l of losers) {
      lines.push(`- [${l.ratio.toFixed(1)}× baseline] "${sanitizePromptText(l.text)}"`);
    }
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
    tiktok: "TikTok: 3–6 tags. Blend 1–2 broad discovery tags with niche ones — tags carry real reach here.",
    youtube: "YouTube: 2–5 tags in the description. Keyword-forward — put the most important search term first.",
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

export function planSystemPrompt(inputs: PlanGenInputs): string {
  const { brief } = inputs;
  const voiceProfile = brief.voice_profile as VoiceProfile | null;
  const activeChannels = Array.from(new Set(inputs.channelMix.map((c) => c.channel)));

  // Cross-block dedupe: recentContent (45d, includes posted) and postExemplars
  // (28d winners, also posted) overlap, so the same winning post can land in
  // BOTH "DO NOT REPEAT THESE" and "write more like these" — contradictory.
  // Drop any recentContent item whose snippet is contained in (or contains)
  // an exemplar's text once both are normalized; exemplars win because their
  // block teaches the planner the shape to emulate.
  const exemplarNorms = (inputs.postExemplars ?? []).map((e) =>
    normalizeForDedupe(e.text),
  );
  const recentContent = exemplarNorms.length
    ? (inputs.recentContent ?? []).filter((it) => {
        const snip = normalizeForDedupe(it.snippet);
        if (!snip) return true;
        return !exemplarNorms.some(
          (ex) => ex.includes(snip) || snip.includes(ex),
        );
      })
    : inputs.recentContent;

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
    recentContentBlock(recentContent),
    themeWinnersBlock(inputs.themeWinners),
    postExemplarsBlock(inputs.postExemplars),
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
    channelToneBlock(activeChannels),
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

export function voiceProfileBlock(v: VoiceProfile): string {
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
    "Keep `overview` to a tight 2-3 sentences — it MUST be 800 characters or fewer.",
    "For every variant either write real `text`, OR set `skip: true` with a one-line `rationale`. Never leave a variant with empty text and skip unset.",
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

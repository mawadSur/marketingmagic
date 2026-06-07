import type { Database, VoiceProfile } from "@/lib/db/types";
import { CHANNELS, type ChannelId } from "@/lib/channels/registry";
import {
  channelCapsBlock,
  channelToneBlock,
  linkedinLongFormBlock,
} from "@/lib/plan/channel-guidance";
import type { SourceContext } from "@/lib/plan/prompt";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

// ─────────────────────────────────────────────────────────────
// Atomization prompt builder (Bet 2 — Atomization Engine)
// ─────────────────────────────────────────────────────────────
//
// Distinct from src/lib/plan/prompt.ts: the planner produces a multi-week
// content *calendar* (per-channel cadence × weeks, spread across days). The
// atomizer takes ONE source and decomposes it into atoms — single distinct
// points — then renders each atom natively per channel. No calendar, no
// scheduling; drafts land unscheduled in the approval queue.
//
// Reuse, not duplication: the per-channel cap + tone + LinkedIn long-form
// guidance come from the SHARED @/lib/plan/channel-guidance module that the
// planner also uses, and the source-grounding framing mirrors the planner's
// sourceBlock. Voice/brand rules are summarised compactly here (the atomizer
// doesn't need the planner's full signals/competitor machinery).

export interface AtomizeInputs {
  brief: Brief;
  source: SourceContext;
  // The channels the workspace has connected — the atomizer only emits
  // variants for these (re-validated downstream).
  channels: ChannelId[];
  // Soft target for how many atoms to produce. The model may produce fewer if
  // the source is thin or more if it's dense, but this anchors the ask.
  atomTarget: number;
}

// Compact voice-profile rendering. Mirrors the planner's voiceProfileBlock but
// trimmed — the atomizer wants the register, not the full signal surface.
function voiceProfileBlock(v: VoiceProfile): string {
  const lines: string[] = [
    "### Voice profile (match this register precisely)",
    v.summary,
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
      `- Signature phrases (use where they fit naturally): ${v.signature_phrases
        .slice(0, 10)
        .map((s) => `"${s}"`)
        .join(", ")}`,
    );
  }
  if (v.do_not_say.length > 0) {
    lines.push(`- Voice anti-patterns: ${v.do_not_say.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

// The source is the WHOLE input here (not an anchor among many ideas). Frame
// it as the material to decompose. Quotes stay verbatim — same rule as the
// planner's sourceBlock.
function sourceBlock(src: SourceContext): string {
  const lines: string[] = [];
  lines.push("## Source to atomize (this is the entire input — decompose it)");
  lines.push(
    "Break this single source into distinct atoms — one self-contained point, angle, story, " +
      "stat, or takeaway per atom. Every atom must be grounded in the material below; do not " +
      "invent claims the source doesn't support. When you quote, use the quote verbatim (no " +
      "paraphrasing). Preserve the customer's own words / off-script lines as hooks where natural.",
  );
  lines.push("");
  lines.push(`### Title: ${src.title}`);
  if (src.sourceUrl) lines.push(`Source URL: ${src.sourceUrl}`);
  lines.push("");
  lines.push("### Summary");
  lines.push(src.summary);
  if (src.themes.length > 0) {
    lines.push("");
    lines.push("### Themes (reuse the EXACT label as the atom's theme tag)");
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

export function atomizeSystemPrompt(inputs: AtomizeInputs): string {
  const { brief } = inputs;
  const voiceProfile = brief.voice_profile as VoiceProfile | null;
  const channels = Array.from(new Set(inputs.channels));

  return [
    "You are the atomization brain of marketingmagic, a marketing-automation tool.",
    "Your job: take ONE long-form source and break it into many channel-native social posts.",
    "Each post must sound like the brand wrote it themselves — not like a summary of the source.",
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
      ? `### Do NOT say (avoid these words/phrases verbatim)\n${brief.do_not_say
          .map((w) => `- ${w}`)
          .join("\n")}\n`
      : "",
    voiceProfile ? voiceProfileBlock(voiceProfile) : "",
    sourceBlock(inputs.source),
    "## Channel constraints",
    ...channels.map((c) => `- ${CHANNELS[c].label}: ${CHANNELS[c].promptConstraint}`),
    "",
    "## Cross-channel adaptation",
    "Each atom fans out into per-channel variants. Don't paste the same text into every channel — adapt the same core point to each channel's voice and length.",
    "",
    "Hard character limits (the tool will reject anything over):",
    channelCapsBlock(channels),
    "",
    "Tone per channel:",
    channelToneBlock(channels),
    "",
    linkedinLongFormBlock(channels),
    "### When to skip a channel (set `skip: true` on the variant)",
    "- A point that needs room to develop → skip X and Bluesky (too long to compress without losing it).",
    "- A single-image visual quote or behind-the-scenes beat → skip LinkedIn.",
    "- Industry inside-baseball for engineers → skip Instagram (audience mismatch).",
    "Always provide a `rationale` either way — \"why this works here\" or \"why this doesn't fit here\".",
    "",
    "## Rules",
    "- One atom = one distinct point. Do NOT split the same point into two atoms, and do NOT cram two points into one atom.",
    "- Each post must stand on its own. Assume the reader never saw the source.",
    "- Vary the angle across atoms — a stat, a story, a contrarian take, a how-to, a question. Don't repeat the same shape.",
    "- Concrete > abstract. Lean on the source's facts and quotes; never invent numbers.",
    "- No filler. If an atom wouldn't justify a reader's 3 seconds, cut it.",
    "- Reuse the source's theme tags as the atom `theme` where they fit; otherwise pick a short lowercase hyphenated tag.",
    "- For variants where a visual amplifies the message, include an `image_prompt`: one concrete, visual sentence. Omit it where an image would feel forced.",
    voiceProfile
      ? "- For EVERY variant, include a `voice_score` (0-100) self-assessing match to the voice profile above. Be calibrated — 70 is the threshold below which the post is flagged low-confidence."
      : "",
    "- Output strict JSON matching the schema via the tool call. No prose outside the tool call.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function atomizeUserPrompt(inputs: AtomizeInputs): string {
  const channelsAllowed = Array.from(new Set(inputs.channels)).join(", ");
  return [
    `Atomize the source above into ~${inputs.atomTarget} atoms.`,
    `Use only these channel values for variants: ${channelsAllowed}.`,
    "Each atom fans out into per-channel variants — skip channels where the atom doesn't fit (with a rationale).",
    "Theme tags are free-form lowercase labels (e.g. build-progress, pricing-mistakes). Reuse the source's themes where they fit so we can measure engagement per theme.",
    "",
    "Call the submit_atomization tool with the full result. Do not respond with prose.",
  ].join("\n");
}

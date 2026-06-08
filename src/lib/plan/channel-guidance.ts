import { CHANNELS, type ChannelId } from "@/lib/channels/registry";

// ─────────────────────────────────────────────────────────────
// Shared per-channel prompt guidance.
// ─────────────────────────────────────────────────────────────
//
// These three helpers used to live privately inside src/lib/plan/prompt.ts.
// The atomization engine (src/lib/atomize/prompt.ts) needs the exact same
// channel-cap + tone logic to keep cross-channel adaptation consistent
// between the planner and the atomizer — so we lift them here as the single
// source of truth rather than copy-pasting the strings into a second prompt
// builder. prompt.ts re-imports these; nothing about its output changes.

// Per-channel hard caps pulled straight from the registry — keep this one
// source of truth. The prompt reads these, the zod schema enforces them.
export function channelCapsBlock(channels: ChannelId[]): string {
  const lines = channels.map((c) => `- ${CHANNELS[c].label}: ≤ ${CHANNELS[c].maxChars} chars`);
  return lines.join("\n");
}

// Channel-specific tone hints. Brief, opinionated, and aimed at making
// cross-channel adaptation feel like the brand wrote each version itself.
export const CHANNEL_TONE: Record<ChannelId, string> = {
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
  tiktok:
    "Video-first — the caption rides on a vertical short-form video, never stands alone. Hook in the first line, native and conversational. Hashtags 3-6 for discovery.",
  youtube:
    "Video-first — the text is the video description (and the first line seeds the title), never a standalone post. Lead with the value/hook; expand for long-form, keep it tight for Shorts. Keyword-forward; hashtags 2-5.",
};

// Render the per-channel tone block. Callers pass the active channel set so
// only relevant tone hints surface.
export function channelToneBlock(channels: ChannelId[]): string {
  return channels.map((c) => `- ${CHANNELS[c].label}: ${CHANNEL_TONE[c]}`).join("\n");
}

// LinkedIn long-form guidance — emitted only when LinkedIn is in the active
// channel mix. Cross-channel variants tend to collapse into "X-with-more-
// characters" by default: Claude takes the X-shape draft, tacks on a
// transition phrase + a CTA, and ships that as the LinkedIn variant. The
// 3000-char cap is then wasted on a 250-char tweet in a suit. This block
// nudges Claude to use the room when the *idea* has depth, while leaving
// genuine one-beat ideas alone (the schema stays permissive — guidance
// lives here, not in zod).
export function linkedinLongFormBlock(active: ChannelId[]): string {
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

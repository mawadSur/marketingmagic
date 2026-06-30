import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { maxCharsFor, channelSpec, type ChannelId } from "@/lib/channels/registry";
import { voiceProfileBlock } from "@/lib/plan/prompt";
import type { Database, VoiceProfile } from "@/lib/db/types";

type BrandBriefsRow = Database["public"]["Tables"]["brand_briefs"]["Row"];

// ─────────────────────────────────────────────────────────────────────────────
// Per-post brief-faithful regeneration
// ─────────────────────────────────────────────────────────────────────────────
//
// regeneratePostForBrief rewrites ONE existing draft so it matches the
// workspace's CURRENT brand brief + voice profile, while preserving the draft's
// core idea, theme, and target channel. This powers the queue's "your brief
// changed → regenerate these drafts" flow (src/app/(app)/queue/actions.ts).
//
// It is deliberately a focused single-post rewrite (not a full generatePlan
// run): we keep the user's schedule, channel mix, and idea grouping intact and
// only refresh the copy. Same Opus model + maxRetries policy as the planner.

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface RegeneratePostInput {
  brief: BrandBriefsRow;
  channel: string;
  /** The current draft body — the thing we're rewriting. */
  currentText: string;
  /** Theme tag to preserve (free-form), or null for an ungrouped draft. */
  theme: string | null;
}

export interface RegeneratedPost {
  text: string;
  /** 0-100 self-assessed match to the voice profile (100 when no profile set). */
  voice_score: number;
  rationale: string;
}

const REWRITE_TOOL = {
  name: "submit_rewrite",
  description:
    "Submit the single rewritten post. Call this exactly once. Keep the same core " +
    "idea/theme and the same channel; only update wording, tone, framing, and any " +
    "details that conflict with the brand's current brief or voice.",
  input_schema: {
    type: "object",
    required: ["text", "voice_score", "rationale"],
    properties: {
      text: {
        type: "string",
        minLength: 1,
        // Hard cap is re-enforced per-channel by the caller (the final slice
        // below); we use a generous ceiling here so JSON-Schema validation never
        // rejects a legitimately long-form channel (YouTube/Facebook) rewrite.
        maxLength: 8000,
        description: "The rewritten post body, fitting the channel's character limit.",
      },
      voice_score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "0-100 self-assessment of how well the rewrite matches the brand voice. " +
          "70 is the threshold below which a draft is flagged for manual review.",
      },
      rationale: {
        type: "string",
        minLength: 1,
        maxLength: 600,
        description: "One or two sentences on what you changed and why it now fits the brief.",
      },
    },
    additionalProperties: false,
  },
} as const;

function briefSystemPrompt(input: RegeneratePostInput): string {
  const { brief } = input;
  const voiceProfile = brief.voice_profile as VoiceProfile | null;
  const channel = input.channel as ChannelId;
  const spec = channelSpec(channel);
  const maxChars = maxCharsFor(channel);

  return [
    "You are the voice of a brand using marketingmagic, a marketing-automation tool.",
    "Your job: REWRITE one existing draft post so it faithfully matches the brand's",
    "CURRENT brief and voice below. The brief or voice was just updated, and this",
    "draft was written against an older version — bring it in line.",
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
    "## Channel",
    `- Target channel: ${spec?.label ?? channel}`,
    spec ? `- Channel guidance: ${spec.promptConstraint}` : "",
    `- HARD character limit: ${maxChars}. The tool rejects anything longer — stay under it.`,
    "",
    "## Rules",
    "- Preserve the original idea and theme. This is a rewrite, not a new post.",
    "- Keep it self-contained — assume the reader has no prior context.",
    "- Match the brand's current voice precisely; drop anything that now conflicts with the brief.",
    "- Do not invent facts, metrics, or claims that weren't in the original draft.",
    voiceProfile
      ? "- Include a calibrated voice_score (0-100). Below 70 means it still doesn't match the voice."
      : "- No voice profile is set, so report voice_score: 100.",
    "- Call submit_rewrite exactly once with the result.",
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(input: RegeneratePostInput): string {
  return [
    input.theme ? `Theme to preserve: ${input.theme}` : "Theme: (none — standalone post)",
    "",
    "Existing draft to rewrite:",
    "```",
    input.currentText,
    "```",
    "",
    "Rewrite it to match the current brief and voice. Call submit_rewrite with the result.",
  ].join("\n");
}

/**
 * Rewrite a single draft to match the current brief/voice. Throws on an API or
 * validation failure (the caller treats a throw as "skip this post, keep the
 * original"). The returned text is guaranteed non-empty and ≤ the channel cap.
 */
export async function regeneratePostForBrief(
  input: RegeneratePostInput,
): Promise<RegeneratedPost> {
  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: briefSystemPrompt(input),
    tools: [REWRITE_TOOL],
    tool_choice: { type: "tool", name: "submit_rewrite" },
    messages: [{ role: "user", content: userPrompt(input) }],
  });

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_rewrite") {
    throw new Error("Claude did not call submit_rewrite.");
  }
  const out = toolUse.input as { text?: unknown; voice_score?: unknown; rationale?: unknown };
  const text = typeof out.text === "string" ? out.text.trim() : "";
  if (!text) throw new Error("Regeneration returned empty text.");

  // Belt-and-suspenders char cap (the tool ceiling is the LinkedIn max; clamp to
  // the actual channel limit the same way the insert paths do).
  const max = maxCharsFor(input.channel as ChannelId);
  const capped = text.length > max ? text.slice(0, max - 1) + "…" : text;

  const rawScore = typeof out.voice_score === "number" ? out.voice_score : 100;
  const voice_score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const rationale = typeof out.rationale === "string" ? out.rationale : "";

  return { text: capped, voice_score, rationale };
}

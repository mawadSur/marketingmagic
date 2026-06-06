// Phase 4.5 — Voice-aware reply drafter.
//
// =======================================================================
// HARD RULE — NEVER AUTO-SEND.
// =======================================================================
//
// `draftReply` returns 1-2 candidate reply strings. It does NOT call any
// social platform's send API. Sending requires the user to click "Send"
// in /inbox/[id], which routes through sendReplyAction. That action is
// the SOLE place we hit a channel's reply endpoint.
//
// Even if a workspace has trust_mode enabled on its social_accounts row
// (which we use to skip approval on outbound POSTS), REPLIES bypass
// trust_mode entirely. Every reply requires explicit user intent. The
// reasoning: a reply has a named recipient, and pushing into someone's
// notifications without a human eyeball on it is the wrong default for
// a marketing automation tool — the asymmetry between "wrong post on
// our timeline" and "wrong reply at someone with a 100k audience" is
// large.
//
// This rule is enforced in three places:
//   1. Nothing in this file ever imports a *Reply helper from
//      src/lib/social/*. The drafter is text-out only.
//   2. sendReplyAction (the only caller of the *Reply helpers) is a
//      server action gated on an authed user session.
//   3. The /inbox/[id] UI is a server component; sending goes through
//      a form action requiring a manual button click.
//
// If you find yourself wanting to auto-send replies based on some
// heuristic, the answer is no. Add a "queue a draft for review"
// affordance instead.
// =======================================================================

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import type { VoiceProfile } from "@/lib/db/types";

const MODEL = "claude-opus-4-8";

// Each draft is short. The Claude call is tool-bound to a single
// emission with two strings so we never get back prose or a refusal.
const MAX_DRAFT_CHARS = 500;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface ReplyInteractionInput {
  channel: "x" | "linkedin" | "bluesky" | "instagram" | "threads";
  author_handle: string;
  author_display_name: string | null;
  body: string;
}

export interface ReplyWorkspaceContext {
  // The voice profile extracted in Phase 1. Optional — when null we
  // fall back to a generic friendly-direct tone, but the drafter is
  // best when this is populated.
  voiceProfile: VoiceProfile | null;
  // Free-form `voice` field on brand_briefs. Used as a fallback /
  // supplement when voiceProfile is null or thin.
  voice: string;
  // The "never say these" list. Treated as hard constraints.
  doNotSay: string[];
  // Free-form product description, gives Claude a one-line context.
  productDescription: string;
  // If this is a reply to one of our own posts, pass the post body
  // so Claude can stay on topic.
  parentPostText?: string | null;
}

export interface ReplyDraftResult {
  drafts: string[]; // 1-2 candidate replies
  usage: { input_tokens: number; output_tokens: number };
}

const DRAFT_TOOL = {
  name: "submit_reply_drafts",
  description:
    "Submit 1 or 2 candidate reply drafts. Each should be a complete, ready-to-send reply.",
  input_schema: {
    type: "object",
    required: ["drafts"],
    properties: {
      drafts: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DRAFT_CHARS,
        },
        description:
          "1 or 2 reply candidates. Each must stand alone — no 'Option A:' prefixes. " +
          "Match the channel's natural length (X: ≤240 chars, LinkedIn: 1-3 sentences).",
      },
    },
    additionalProperties: false,
  },
} as const;

function buildSystem(ctx: ReplyWorkspaceContext): string {
  const lines: string[] = [];
  lines.push(
    "You are drafting reply candidates for marketingmagic, a marketing-automation tool.",
  );
  lines.push(
    "Your output is a draft — a HUMAN reviews and clicks send. Never auto-send.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push("- RESPOND, don't pitch. Treat replies as conversation, not sales.");
  lines.push(
    "- Stay in the workspace's voice (see below). Match cadence, vocabulary, and emoji habit.",
  );
  lines.push(
    "- Be concise. Replies are short by design — never bury the lede.",
  );
  lines.push(
    "- If the reply is hostile or a clear bot, return a single neutral acknowledgement (or skip — return 1 short draft like 'Appreciate the note.').",
  );
  lines.push(
    "- Never make commitments on behalf of the brand (no pricing promises, no roadmap claims).",
  );
  lines.push("- Never use the phrases in do_not_say below.");
  lines.push("- Output exactly 1 or 2 drafts via submit_reply_drafts. No prose.");

  lines.push("");
  lines.push(`Product: ${ctx.productDescription.slice(0, 600)}`);
  if (ctx.voice) {
    lines.push(`Voice (freeform): ${ctx.voice.slice(0, 600)}`);
  }
  if (ctx.voiceProfile) {
    lines.push("");
    lines.push("Voice profile (structured):");
    lines.push(`- formality: ${ctx.voiceProfile.formality}`);
    lines.push(`- emoji_usage: ${ctx.voiceProfile.emoji_usage}`);
    lines.push(`- sentence_length_avg: ${ctx.voiceProfile.sentence_length_avg}`);
    if (ctx.voiceProfile.signature_phrases?.length > 0) {
      lines.push(
        `- signature_phrases: ${ctx.voiceProfile.signature_phrases.join(", ")}`,
      );
    }
    if (ctx.voiceProfile.punctuation_quirks?.length > 0) {
      lines.push(
        `- punctuation_quirks: ${ctx.voiceProfile.punctuation_quirks.join(", ")}`,
      );
    }
    if (ctx.voiceProfile.summary) {
      lines.push(`- summary: ${ctx.voiceProfile.summary}`);
    }
  }
  if (ctx.doNotSay.length > 0) {
    lines.push("");
    lines.push(`Do not say: ${ctx.doNotSay.join(" | ")}`);
  }
  return lines.join("\n");
}

function buildUser(
  interaction: ReplyInteractionInput,
  ctx: ReplyWorkspaceContext,
): string {
  const lines: string[] = [];
  lines.push(`Channel: ${interaction.channel}`);
  lines.push(`Author: @${interaction.author_handle}${interaction.author_display_name ? ` (${interaction.author_display_name})` : ""}`);
  if (ctx.parentPostText) {
    lines.push("");
    lines.push("Our original post (for context):");
    lines.push("---");
    lines.push(ctx.parentPostText.slice(0, 1500));
    lines.push("---");
  }
  lines.push("");
  lines.push("Their message:");
  lines.push("---");
  lines.push(interaction.body.slice(0, 2000));
  lines.push("---");
  lines.push("");
  lines.push("Draft 1 or 2 reply candidates. Submit via submit_reply_drafts.");
  return lines.join("\n");
}

export async function draftReply(
  interaction: ReplyInteractionInput,
  workspace: ReplyWorkspaceContext,
): Promise<ReplyDraftResult> {
  if (interaction.body.trim().length === 0) {
    throw new Error("Cannot draft a reply for an empty message.");
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: buildSystem(workspace), cache_control: { type: "ephemeral" } },
    ],
    tools: [DRAFT_TOOL],
    tool_choice: { type: "tool", name: "submit_reply_drafts" },
    messages: [{ role: "user", content: buildUser(interaction, workspace) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_reply_drafts") {
    throw new Error("Claude did not call submit_reply_drafts.");
  }
  const input = toolUse.input as { drafts?: unknown };
  const rawDrafts = Array.isArray(input.drafts) ? input.drafts : [];
  const drafts = rawDrafts
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && d.length <= MAX_DRAFT_CHARS)
    .slice(0, 2);
  if (drafts.length === 0) {
    throw new Error("Claude returned no usable drafts.");
  }

  return {
    drafts,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

// Phase 6.6 — Claude pattern extraction for competitor winners.
//
// For each post flagged is_winner=true by detect-outliers.ts, we ask
// Claude (sonnet-4-6, tool_use forcing) to return:
//   - 1-3 tags from a closed vocabulary (see COMPETITOR_PATTERN_TAGS)
//   - one "possible reason" line, never adversarial
//
// We do NOT call Claude for every pulled post — only winners — to keep
// the token budget tight. Results are cached on the row itself
// (pattern_tags, pattern_reason) so subsequent reads are free.
//
// Anti-harassment guardrail: the system prompt explicitly refuses to
// produce takedowns, snark, or any framing centred on the author. We
// describe content, not people. Claude's own safety policy is the
// second-line guardrail.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import {
  competitorPatternSchema,
  COMPETITOR_PATTERN_TAGS,
  type CompetitorPattern,
} from "@/lib/competitors/schema";

const MODEL = "claude-sonnet-4-6";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

const EXTRACT_TOOL = {
  name: "submit_competitor_pattern",
  description:
    "Submit pattern tags + a one-line possible-reason for this competitor post. " +
    "Tags MUST come from the allowed vocabulary. Reason is one sentence; describes the post, " +
    "not the author. Never adversarial.",
  input_schema: {
    type: "object",
    required: ["tags", "reason"],
    properties: {
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "string",
          enum: [...COMPETITOR_PATTERN_TAGS],
        },
        description:
          "1-3 tags (1-5 max) describing structural patterns in the post. " +
          "Use multiple only when genuinely independent — e.g. 'list' AND 'data-driven'.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 280,
        description:
          "One-sentence 'possible reason this post outperformed.' Describes the post " +
          "(hook, structure, format), NOT the author. Word 'possible' is required — " +
          "we are not claiming causal attribution.",
      },
    },
    additionalProperties: false,
  },
} as const;

function buildSystem(): string {
  return [
    "You are a content-pattern analyst for marketingmagic, a marketing automation tool.",
    "Your job: given a competitor's high-performing post, return 1-3 structural tags",
    "from a closed vocabulary and one short 'possible reason' sentence.",
    "",
    "HARD RULES:",
    "- Describe the POST, not the author. Do not name the handle. Do not speculate about",
    "  the author's motives, character, or personal life.",
    "- Never adversarial. We will refuse to draft takedowns, snark, or attacks of any kind.",
    "  If the post itself is an attack on someone, return tags but write a neutral reason.",
    "- Reason starts with 'Possibly' or similar hedge. We are not claiming causality.",
    "- Tags MUST be drawn from the schema enum. Do not invent new tags.",
    "- One sentence. No emoji. No quote-tweet bait.",
    "- Call submit_competitor_pattern exactly once.",
  ].join("\n");
}

function buildUser(text: string): string {
  return [
    "Competitor post (full text below). Classify by structure and propose one possible reason it outperformed.",
    "",
    "---",
    text.slice(0, 4000),
    "---",
  ].join("\n");
}

export interface PatternExtractResult {
  pattern: CompetitorPattern;
  usage: { input_tokens: number; output_tokens: number };
}

export async function extractCompetitorPattern(text: string): Promise<PatternExtractResult> {
  if (text.trim().length < 5) {
    throw new Error("Post text too short to analyse.");
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: buildSystem(), cache_control: { type: "ephemeral" } }],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "submit_competitor_pattern" },
    messages: [{ role: "user", content: buildUser(text) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_competitor_pattern") {
    throw new Error("Claude did not call submit_competitor_pattern.");
  }

  const parsed = competitorPatternSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Pattern extraction validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    pattern: parsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

// Handle-finder — AI candidate generator.
//
// generateHandleCandidates(seed, {count}) calls Claude with a single forced tool
// call: "propose N brandable handles for this brand." Mirrors
// src/lib/variations/generate.ts EXACTLY — the SHARED Opus 4.8 client,
// maxRetries:6, one tool_choice-forced call, zod re-validation, NO
// temperature/top_p (Opus 4.8 rejects them). No new AI provider.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import {
  dedupeCandidates,
  handleCandidatesSchema,
  DEFAULT_CANDIDATES,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  type HandleCandidate,
  type HandleSeed,
} from "./schema";
import { handleSystemPrompt, handleUserPrompt } from "./prompt";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  // maxRetries=6 matches every other call site — a 429 inside the per-minute
  // input-token window rides out the SDK backoff rather than surfacing raw.
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface GenerateHandlesOptions {
  count?: number;
}

export interface GenerateHandlesResult {
  candidates: HandleCandidate[];
  usage: { input_tokens: number; output_tokens: number };
}

function clampCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CANDIDATES;
  if (!Number.isInteger(value)) throw new Error(`Count must be an integer (got ${value}).`);
  if (value < MIN_CANDIDATES || value > MAX_CANDIDATES) {
    throw new Error(`Count must be ${MIN_CANDIDATES}-${MAX_CANDIDATES} (got ${value}).`);
  }
  return value;
}

// Structured-output tool. Forcing the call guarantees JSON matching the schema;
// the minItems/maxItems mirror the requested count and zod re-validates.
function buildTool(count: number) {
  return {
    name: "submit_handles",
    description:
      `Submit exactly ${count} distinct, brandable social-media handles obeying every hard rule ` +
      "(lowercase, 3-15 chars, letters/digits/one optional underscore). Call this tool exactly once.",
    input_schema: {
      type: "object",
      required: ["candidates"],
      properties: {
        candidates: {
          type: "array",
          minItems: count,
          maxItems: count,
          items: {
            type: "object",
            required: ["handle", "rationale"],
            properties: {
              handle: {
                type: "string",
                minLength: 3,
                maxLength: 15,
                description:
                  "The bare username — lowercase letters/digits, optional single underscore. No @, no spaces, no dots/dashes.",
              },
              rationale: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                description: "One line: why this works as a handle for the brand.",
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  } as const;
}

export async function generateHandleCandidates(
  seed: HandleSeed,
  options: GenerateHandlesOptions = {},
): Promise<GenerateHandlesResult> {
  const count = clampCount(options.count);
  const tool = buildTool(count);

  const response = await client().messages.create({
    model: MODEL,
    // count small {handle, rationale} objects — comfortably bounded.
    max_tokens: 2048,
    system: [{ type: "text", text: handleSystemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_handles" },
    messages: [{ role: "user", content: handleUserPrompt(seed, count) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_handles") {
    throw new Error("Claude did not call submit_handles.");
  }

  const parsed = handleCandidatesSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Handle candidates validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    candidates: dedupeCandidates(parsed.data.candidates),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

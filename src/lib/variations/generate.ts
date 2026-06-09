// Hook×body variation generator (Hormozi organic-first slice #3).
//
// generateVariationMatrix(seed, {hooks, bodies}) calls Claude with a single
// forced tool call: "here's a source clip — commit to N distinct hooks and M
// distinct bodies." The cross product (N×M variations) is assembled in code
// (schema.ts:assembleVariations), so the count is guaranteed — default 10×3=30.
//
// Mirrors src/lib/experiments/generate.ts exactly (the pattern the task pins
// down): the SHARED Opus 4.8 client, maxRetries:6, a single tool_choice-forced
// call, zod re-validation, NO temperature/top_p (Opus 4.8 rejects them). No new
// AI provider — same Anthropic SDK every other call site uses.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import {
  assembleVariations,
  variationMatrixSchema,
  DEFAULT_BODIES,
  DEFAULT_HOOKS,
  MAX_BODIES,
  MAX_HOOKS,
  MIN_BODIES,
  MIN_HOOKS,
  type Variation,
  type VariationMatrix,
} from "@/lib/variations/schema";
import {
  variationSystemPrompt,
  variationUserPrompt,
  type VariationSeed,
} from "@/lib/variations/prompt";

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  // maxRetries=6 matches every other call site — a 429 inside the per-minute
  // input-token window rides out the SDK backoff rather than surfacing raw.
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface VariationMatrixOptions {
  hooks?: number;
  bodies?: number;
}

export interface GenerateVariationsResult {
  matrix: VariationMatrix;
  variations: Variation[];
  hookCount: number;
  bodyCount: number;
  usage: { input_tokens: number; output_tokens: number };
}

// Structured-output tool. Forcing the call guarantees valid JSON matching the
// schema. The minItems/maxItems mirror the matrix bounds; zod re-validates.
function buildTool(hookCount: number, bodyCount: number) {
  return {
    name: "submit_variation_matrix",
    description:
      `Submit exactly ${hookCount} distinct hooks and exactly ${bodyCount} distinct bodies for the ` +
      "source clip. Same core message, organic-native, hook-first, text-overlay CTA (never spoken). " +
      "Call this tool exactly once.",
    input_schema: {
      type: "object",
      required: ["overview", "hooks", "bodies"],
      properties: {
        overview: { type: "string", minLength: 1, maxLength: 800 },
        hooks: {
          type: "array",
          minItems: hookCount,
          maxItems: hookCount,
          description: "The scroll-stopping openers. Each is a {spoken, visual} pair.",
          items: {
            type: "object",
            required: ["spoken", "visual"],
            properties: {
              spoken: {
                type: "string",
                minLength: 1,
                maxLength: 280,
                description: "First line said to camera. Hook-first — lead with the payoff/tension.",
              },
              visual: {
                type: "string",
                minLength: 1,
                maxLength: 280,
                description:
                  "What is ON SCREEN in the opening shot — the pattern interrupt. Concrete + filmable.",
              },
            },
            additionalProperties: false,
          },
        },
        bodies: {
          type: "array",
          minItems: bodyCount,
          maxItems: bodyCount,
          description: "The payloads after the hook. Each is a {spoken, cta_overlay} pair.",
          items: {
            type: "object",
            required: ["spoken", "cta_overlay"],
            properties: {
              spoken: {
                type: "string",
                minLength: 1,
                maxLength: 1200,
                description:
                  "The payload — the point/proof/turn. Same core claim, different route. No spoken CTA.",
              },
              cta_overlay: {
                type: "string",
                minLength: 1,
                maxLength: 120,
                description: "Short ON-SCREEN text CTA (≤ ~8 words). Never a spoken instruction.",
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

function clampCount(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new Error(`Count must be an integer (got ${value}).`);
  }
  if (value < min || value > max) {
    throw new Error(`Count must be ${min}-${max} (got ${value}).`);
  }
  return value;
}

export async function generateVariationMatrix(
  seed: VariationSeed,
  options: VariationMatrixOptions = {},
): Promise<GenerateVariationsResult> {
  // Validate inputs at the boundary.
  if (!seed.text || seed.text.trim().length === 0) {
    throw new Error("Source post text is empty.");
  }
  const hookCount = clampCount(options.hooks, DEFAULT_HOOKS, MIN_HOOKS, MAX_HOOKS);
  const bodyCount = clampCount(options.bodies, DEFAULT_BODIES, MIN_BODIES, MAX_BODIES);

  const tool = buildTool(hookCount, bodyCount);

  const response = await client().messages.create({
    model: MODEL,
    // hookCount hooks + bodyCount bodies, each a small object — comfortably
    // under this ceiling even at the 12×5 max. Non-streaming is fine here (the
    // output is bounded, unlike the atomizer's open-ended fan-out).
    max_tokens: 8192,
    system: [
      { type: "text", text: variationSystemPrompt(seed), cache_control: { type: "ephemeral" } },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_variation_matrix" },
    messages: [{ role: "user", content: variationUserPrompt(seed, hookCount, bodyCount) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_variation_matrix") {
    throw new Error("Claude did not call submit_variation_matrix.");
  }

  const parsed = variationMatrixSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Variation matrix validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const variations = assembleVariations(parsed.data);

  return {
    matrix: parsed.data,
    variations,
    hookCount: parsed.data.hooks.length,
    bodyCount: parsed.data.bodies.length,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

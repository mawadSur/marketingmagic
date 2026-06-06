// Phase 6B — Quick Experiments variant generator.
//
// generateVariants(post, count) calls Claude with a tight, single-purpose
// prompt: "here's a post. Generate {count} variants of the same idea —
// different hooks, same theme, same channel, same voice." Voice-aware
// when the workspace has a voice_profile.
//
// This is intentionally separate from the main plan generator (no
// best-of-3 voice retry, no fan-out, no channel adaptation). The goal is
// fast variants of an *existing* approved post, not a fresh plan.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import type { VoiceProfile } from "@/lib/db/types";
import { maxCharsFor } from "@/lib/channels/registry";

const MODEL = "claude-opus-4-8";

// Cap variant count at 5 (spec). The minimum is 2 — a 1-variant
// experiment would just be a reschedule.
export const MIN_VARIANT_COUNT = 2;
export const MAX_VARIANT_COUNT = 5;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface VariantSeed {
  // The post we're varying. Only the fields the prompt actually needs.
  text: string;
  channel: string;
  theme: string | null;
  // Optional brand-voice context. When unset Claude relies on the post
  // itself as the voice anchor (still works — the user wrote / approved it).
  voiceProfile?: VoiceProfile | null;
  productDescription?: string | null;
}

export interface GeneratedVariant {
  text: string;
  hook: string;
  rationale: string;
}

export interface GenerateVariantsResult {
  variants: GeneratedVariant[];
  usage: { input_tokens: number; output_tokens: number };
}

// Tool schema. Strict — Claude commits to N variants with a hook + a
// one-sentence "why this hook is different from the parent" rationale.
// Hook is mainly for debugging (lets us tell at a glance which arm fired)
// but it's also a useful piece of self-discipline for the model: forcing
// a distinct hook stops it from regenerating near-duplicates of the parent.
function buildTool(count: number, maxChars: number) {
  return {
    name: "submit_variants",
    description:
      `Submit exactly ${count} variants of the supplied post. Same idea, same theme, same channel, ` +
      "same voice — different opener / framing / hook. Call this tool exactly once.",
    input_schema: {
      type: "object",
      required: ["variants"],
      properties: {
        variants: {
          type: "array",
          minItems: count,
          maxItems: count,
          items: {
            type: "object",
            required: ["text", "hook", "rationale"],
            properties: {
              text: {
                type: "string",
                minLength: 1,
                maxLength: maxChars,
                description: `Full body of the variant. Must stay under ${maxChars} characters (channel hard cap).`,
              },
              hook: {
                type: "string",
                minLength: 1,
                maxLength: 240,
                description:
                  "The first sentence / opener of this variant — what makes it different from the parent. Used for debugging and as the experiment-row label.",
              },
              rationale: {
                type: "string",
                minLength: 1,
                maxLength: 400,
                description:
                  "One sentence explaining why this variant's hook is meaningfully different from the parent's hook — not a sales pitch.",
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

const variantSchema = z.object({
  text: z.string().trim().min(1),
  hook: z.string().trim().min(1).max(240),
  rationale: z.string().trim().min(1).max(400),
});
const variantsSchema = z.object({
  variants: z.array(variantSchema).min(MIN_VARIANT_COUNT).max(MAX_VARIANT_COUNT),
});

function buildSystemPrompt(seed: VariantSeed): string {
  const lines: string[] = [
    "You generate variants of an existing approved social post.",
    "Same idea, same theme, same channel, same brand voice — only the hook / opener / framing changes.",
    "Do not invent new themes. Do not change the underlying claim. Do not paste the parent verbatim.",
    "",
    `## Channel: ${seed.channel}`,
    `Hard character cap: ${maxCharsFor(seed.channel)} characters per variant. The system rejects anything over.`,
  ];
  if (seed.theme) {
    lines.push("");
    lines.push(`## Theme: ${seed.theme}`);
    lines.push("Every variant must stay inside this theme.");
  }
  if (seed.productDescription) {
    lines.push("");
    lines.push("## Product context");
    lines.push(seed.productDescription);
  }
  if (seed.voiceProfile) {
    lines.push("");
    lines.push("## Voice profile (match this register precisely)");
    lines.push(seed.voiceProfile.summary);
    lines.push("");
    lines.push(`- Formality: ${seed.voiceProfile.formality}`);
    lines.push(`- Emoji usage: ${seed.voiceProfile.emoji_usage}`);
    if (seed.voiceProfile.opener_patterns.length > 0) {
      lines.push(
        `- Typical openers: ${seed.voiceProfile.opener_patterns
          .slice(0, 6)
          .map((s) => `"${s}"`)
          .join(", ")}`,
      );
    }
    if (seed.voiceProfile.signature_phrases.length > 0) {
      lines.push(
        `- Signature phrases: ${seed.voiceProfile.signature_phrases
          .slice(0, 6)
          .map((s) => `"${s}"`)
          .join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

function buildUserPrompt(seed: VariantSeed, count: number): string {
  return [
    `Here is the parent post (channel: ${seed.channel}):`,
    "",
    "<<<PARENT_POST",
    seed.text,
    "PARENT_POST",
    "",
    `Generate exactly ${count} variants. Each must:`,
    "- Express the same core idea as the parent",
    "- Use a clearly different hook / opener / framing",
    "- Stay inside the channel's character cap",
    "- Sound like the same brand voice as the parent",
    "",
    "Call submit_variants exactly once. No prose outside the tool call.",
  ].join("\n");
}

export async function generateVariants(
  seed: VariantSeed,
  count = 3,
): Promise<GenerateVariantsResult> {
  if (!Number.isInteger(count) || count < MIN_VARIANT_COUNT || count > MAX_VARIANT_COUNT) {
    throw new Error(
      `Variant count must be ${MIN_VARIANT_COUNT}-${MAX_VARIANT_COUNT} (got ${count}).`,
    );
  }
  if (!seed.text || seed.text.trim().length === 0) {
    throw new Error("Parent post text is empty.");
  }

  const maxChars = maxCharsFor(seed.channel);
  const tool = buildTool(count, maxChars);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: "text", text: buildSystemPrompt(seed), cache_control: { type: "ephemeral" } },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_variants" },
    messages: [{ role: "user", content: buildUserPrompt(seed, count) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_variants") {
    throw new Error("Claude did not call submit_variants.");
  }

  const parsed = variantsSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Variant validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  // Truncate any variant that snuck past the schema cap (shouldn't happen
  // but cheap belt-and-suspenders; the inserted post row also enforces it).
  const variants = parsed.data.variants.map((v) => ({
    text: v.text.length > maxChars ? v.text.slice(0, maxChars - 1) + "…" : v.text,
    hook: v.hook,
    rationale: v.rationale,
  }));

  return {
    variants,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

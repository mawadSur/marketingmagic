import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { planSchema, type GeneratedPlan } from "@/lib/plan/schema";
import { planSystemPrompt, planUserPrompt, type PlanGenInputs } from "@/lib/plan/prompt";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";

const MODEL = "claude-sonnet-4-6";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

export interface PlanGenResult {
  plan: GeneratedPlan;
  raw: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

// Structured-output tool. By forcing Claude to call this tool, the API
// guarantees the input is valid JSON matching the schema — no more
// "unescaped quote inside a post" parser failures.
//
// Phase 2 shape: the tool emits `ideas[]`, each idea fanning out to N
// channel variants. The model can mark a variant `skip:true` to signal
// "this channel doesn't fit this idea". JSON Schema can't enforce a
// per-channel char cap (the enum + max-length interact awkwardly), so we
// use the LinkedIn ceiling here and re-validate per-channel in zod.
const PLAN_TOOL = {
  name: "submit_plan",
  description:
    "Submit the generated posting plan. Call this exactly once with the full plan. " +
    "Each idea fans out into per-channel variants — adapt the same core message to each " +
    "channel's voice and length. Use skip:true for channels where the idea doesn't fit.",
  input_schema: {
    type: "object",
    required: ["plan_name", "overview", "ideas"],
    properties: {
      plan_name: { type: "string", minLength: 1, maxLength: 120 },
      overview: { type: "string", minLength: 1, maxLength: 800 },
      ideas: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description:
          "List of post ideas. Each idea is one piece of content adapted into per-channel variants.",
        items: {
          type: "object",
          required: ["idea_label", "theme", "suggested_scheduled_at", "variants"],
          properties: {
            idea_label: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description: "Short human-readable label for this idea — used for logging/debugging.",
            },
            theme: {
              type: "string",
              minLength: 1,
              maxLength: 60,
              description:
                "Free-form theme tag (e.g. build-progress, winner-announcement). Reuse across ideas of the same category.",
            },
            suggested_scheduled_at: {
              type: "string",
              description: "ISO 8601 UTC datetime (e.g. 2026-05-15T14:00:00Z) — applies to all variants of this idea.",
            },
            variants: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                required: ["channel", "text", "rationale"],
                properties: {
                  channel: {
                    type: "string",
                    enum: [...ENABLED_CHANNELS],
                  },
                  text: {
                    type: "string",
                    maxLength: 3000,
                    description:
                      "Channel-adapted post body. Stay under the channel's character cap (X 280, Bluesky 300, Threads 500, IG 2200, LinkedIn 3000, Facebook keep short ~500). May be empty when skip=true.",
                  },
                  skip: {
                    type: "boolean",
                    description:
                      "Set to true when this idea doesn't fit this channel (e.g. long-form essay → skip X). Provide a rationale either way.",
                  },
                  rationale: {
                    type: "string",
                    minLength: 1,
                    maxLength: 1000,
                    description:
                      "Why this variant works for this channel — or why you're skipping it.",
                  },
                  image_prompt: {
                    type: "string",
                    maxLength: 500,
                    description:
                      "Single sentence describing the paired image. Omit when an image would feel forced.",
                  },
                },
                additionalProperties: false,
              },
            },
            voice_score: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description:
                "Your honest self-assessment of how closely this post matches the supplied " +
                "voice_profile (0=generic AI, 100=indistinguishable from the brand's own posts). " +
                "Required when a voice_profile is provided. Be calibrated — overscoring is worse " +
                "than underscoring because the downstream auto-regenerate loop trusts this number.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export async function generatePlan(inputs: PlanGenInputs): Promise<PlanGenResult> {
  const system = planSystemPrompt(inputs);
  const user = planUserPrompt(inputs);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8192,
    // Cache the system prompt (brand brief + rules) — same brief produces the
    // same system block across regenerations within 5 minutes, so we hit the
    // cache.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [PLAN_TOOL],
    tool_choice: { type: "tool", name: "submit_plan" },
    messages: [{ role: "user", content: user }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_plan") {
    throw new Error("Claude did not call submit_plan.");
  }

  const parsed = planSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Plan validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    plan: parsed.data,
    raw: JSON.stringify(toolUse.input),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { planSchema, type GeneratedPlan } from "@/lib/plan/schema";
import { planSystemPrompt, planUserPrompt, type PlanGenInputs } from "@/lib/plan/prompt";

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
const PLAN_TOOL = {
  name: "submit_plan",
  description: "Submit the generated posting plan. Call this exactly once with the full plan.",
  input_schema: {
    type: "object",
    required: ["plan_name", "overview", "posts"],
    properties: {
      plan_name: { type: "string", minLength: 1, maxLength: 120 },
      overview: { type: "string", minLength: 1, maxLength: 800 },
      posts: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          required: ["channel", "text", "theme", "suggested_scheduled_at", "rationale"],
          properties: {
            channel: { type: "string", enum: ["x", "linkedin", "threads", "instagram", "bluesky"] },
            text: { type: "string", minLength: 1, maxLength: 3000 },
            theme: { type: "string", minLength: 1, maxLength: 60 },
            suggested_scheduled_at: {
              type: "string",
              description: "ISO 8601 UTC datetime (e.g. 2026-05-15T14:00:00Z)",
            },
            rationale: { type: "string", minLength: 1, maxLength: 1000 },
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

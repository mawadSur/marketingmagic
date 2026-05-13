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

export async function generatePlan(inputs: PlanGenInputs): Promise<PlanGenResult> {
  const system = planSystemPrompt(inputs);
  const user = planUserPrompt(inputs);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    // Cache the system prompt (brand brief + rules) — same brief produces the same
    // system block across regenerations within 5 minutes, so we hit the cache.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content.");
  }
  const raw = textBlock.text.trim();
  const json = extractJson(raw);
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Plan validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    plan: parsed.data,
    raw,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

function extractJson(text: string): unknown {
  // Models occasionally wrap in ```json ... ``` — strip code fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]! : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Could not parse JSON from Claude response.");
  }
}

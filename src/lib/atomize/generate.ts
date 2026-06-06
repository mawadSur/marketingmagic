import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { atomizationSchema, type Atomization } from "@/lib/atomize/schema";
import { atomizeSystemPrompt, atomizeUserPrompt, type AtomizeInputs } from "@/lib/atomize/prompt";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";

// Atomization generator — one long-form source → N channel-native posts.
//
// Mirrors src/lib/plan/generate.ts exactly (the pattern the task pins down):
//   - claude-opus-4-8
//   - STREAMING via client.messages.stream() + finalMessage() (a dense source
//     can fan out to dozens of atoms × per-channel variants, well past the
//     ~16k point where non-streaming requests hit the SDK HTTP timeout)
//   - max_tokens ~32000 with a stop_reason==='max_tokens' truncation guard
//   - tool_choice forcing a single submit_atomization call
//   - zod re-validation downstream
//   - NO temperature / top_p / budget_tokens (Opus 4.8 rejects them)

const MODEL = "claude-opus-4-8";

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  // maxRetries=6 matches generate.ts: a 429 inside the per-minute input-token
  // window rides out the SDK backoff (honouring retry-after) rather than
  // surfacing the raw rate-limit error to the user.
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface AtomizeResult {
  atomization: Atomization;
  raw: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

// Structured-output tool. Forcing the tool call guarantees valid JSON matching
// the schema. Per-channel char caps can't be expressed in JSON Schema (the
// enum + max-length interact awkwardly), so we hardcode the LinkedIn ceiling
// here and re-validate per-channel in zod — identical to the planner's tool.
const ATOMIZE_TOOL = {
  name: "submit_atomization",
  description:
    "Submit the atomized posts. Call this exactly once with the full result. " +
    "Each atom is one distinct point from the source, fanned out into per-channel " +
    "variants — adapt the same point to each channel's voice and length. Use skip:true " +
    "for channels where the atom doesn't fit.",
  input_schema: {
    type: "object",
    required: ["overview", "atoms"],
    properties: {
      overview: { type: "string", minLength: 1, maxLength: 800 },
      atoms: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        description:
          "List of atoms. Each atom is one self-contained point from the source, " +
          "rendered into per-channel variants.",
        items: {
          type: "object",
          required: ["atom_label", "theme", "variants"],
          properties: {
            atom_label: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description: "Short human-readable label for this atom — used for logging + grouping.",
            },
            theme: {
              type: "string",
              minLength: 1,
              maxLength: 60,
              description:
                "Free-form theme tag (lowercase, hyphen-separated). Reuse the source's own themes where they fit.",
            },
            variants: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                required: ["channel", "text", "rationale"],
                properties: {
                  channel: { type: "string", enum: [...ENABLED_CHANNELS] },
                  text: {
                    type: "string",
                    maxLength: 3000,
                    description:
                      "Channel-adapted post body. Stay under the channel's character cap (X 280, " +
                      "Bluesky 300, Threads 500, IG 2200, LinkedIn 3000, Facebook keep short ~500). " +
                      "May be empty when skip=true.",
                  },
                  skip: {
                    type: "boolean",
                    description:
                      "Set true when this atom doesn't fit this channel. Provide a rationale either way.",
                  },
                  rationale: {
                    type: "string",
                    minLength: 1,
                    maxLength: 1000,
                    description: "Why this variant works for this channel — or why you're skipping it.",
                  },
                  image_prompt: {
                    type: "string",
                    maxLength: 500,
                    description:
                      "Single sentence describing the paired image. Omit when an image would feel forced.",
                  },
                  voice_score: {
                    type: "number",
                    minimum: 0,
                    maximum: 100,
                    description:
                      "Honest 0-100 self-assessment of voice-profile match (0=generic AI, 100=indistinguishable " +
                      "from the brand). Required when a voice_profile is provided. Be calibrated — overscoring is worse " +
                      "than underscoring because the downstream low-confidence gate trusts this number.",
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export async function atomize(inputs: AtomizeInputs): Promise<AtomizeResult> {
  const system = atomizeSystemPrompt(inputs);
  const user = atomizeUserPrompt(inputs);

  // Stream the response — a dense source can produce dozens of atoms ×
  // per-channel variants (body + rationale each), running well past 16k output
  // tokens. Streaming avoids the SDK HTTP timeout non-streaming requests hit
  // above ~16k; the generous max_tokens ceiling matches the planner.
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 32000,
    // Cache the system prompt (brand brief + source block) — the same source
    // produces the same system block across re-atomizations within 5 minutes,
    // so we hit the cache.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [ATOMIZE_TOOL],
    tool_choice: { type: "tool", name: "submit_atomization" },
    messages: [{ role: "user", content: user }],
  });
  const response = await stream.finalMessage();

  // Truncation guard. If the model runs out of output budget mid-tool-call the
  // tool_use.input comes back partial (missing `atoms`), which otherwise
  // surfaces downstream as a baffling schema error. Catch it here and report
  // the real cause.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Atomization hit the output-token limit before completing. " +
        "Try a shorter source or fewer connected channels.",
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_atomization") {
    throw new Error("Claude did not call submit_atomization.");
  }

  const parsed = atomizationSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Atomization validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    atomization: parsed.data,
    raw: JSON.stringify(toolUse.input),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import {
  extractedSourceSchema,
  type ExtractedSource,
  type RawSource,
} from "@/lib/sources/schema";

// Claude-driven extractor: raw text in → structured ExtractedSource out.
//
// Mirrors the pattern in src/lib/voice/extract.ts and src/lib/plan/generate.ts
// exactly:
//   - Lazy singleton SDK client
//   - claude-opus-4-8 model
//   - tool_choice forcing a single submit_* call
//   - zod re-validation downstream so the JSON Schema doesn't have to be
//     bulletproof on its own
//
// The prompt is constrained: themes are short tags (reusable across sources),
// quotes are verbatim (no paraphrasing — bad-faith Claude tends to "improve"
// quotes if not told otherwise), facts include a context pointer when one
// is available in the source.

const MODEL = "claude-opus-4-8";

// Bound the input we send Claude. Long-form articles get truncated from the
// tail; keeping the head preserves lede + thesis which is what the
// extractor cares about. 32k chars ~ 8k tokens; with prompt overhead we
// stay well under the 200k context window and well under the 8k output cap.
const MAX_INPUT_CHARS = 32_000;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

export interface SourceExtractResult {
  extracted: ExtractedSource;
  usage: { input_tokens: number; output_tokens: number };
}

const EXTRACT_TOOL = {
  name: "submit_source_extraction",
  description:
    "Submit the extracted themes, quotes, and facts from the supplied source. " +
    "Call this exactly once. Quotes must be verbatim — do not paraphrase. " +
    "Themes should be reusable short tags (e.g. 'pricing-mistakes', 'team-building') " +
    "that the marketing planner can match against the workspace's existing themes.",
  input_schema: {
    type: "object",
    required: ["summary", "themes", "quotes", "facts"],
    properties: {
      title: {
        type: "string",
        maxLength: 280,
        description:
          "Short display title for this source. 60-90 chars ideal. " +
          "When the source already has an obvious title, use it verbatim.",
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "2-5 sentence prose summary of the source. Concrete, no marketing-speak. " +
          "Captures the central argument and what's load-bearing for downstream " +
          "post generation.",
      },
      themes: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 60 },
        description:
          "Reusable short theme tags (lowercase, hyphen-separated). 3-10 entries. " +
          "These feed into the planner so generated posts can be measured per-theme.",
      },
      quotes: {
        type: "array",
        maxItems: 15,
        description:
          "Verbatim pull-quotes the planner can use as hooks. Pick 5-10 distinctive ones. " +
          "Do not paraphrase. Skip filler / connective sentences.",
        items: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            speaker: { type: "string", maxLength: 120 },
          },
          additionalProperties: false,
        },
      },
      facts: {
        type: "array",
        maxItems: 20,
        description:
          "Concrete claims (numbers, names, dates, mechanisms) the planner can build " +
          "posts around without inventing data. 3-10 entries.",
        items: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            context: {
              type: "string",
              maxLength: 280,
              description:
                "Optional inline pointer ('paragraph 3', '00:14:22') for a future 'view in source' link.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

function buildSystem(): string {
  return [
    "You are an extraction agent for marketingmagic, a marketing-automation tool.",
    "Your job: read a source artifact (article, transcript, summary) and produce a",
    "structured extraction that the downstream content planner will turn into social posts.",
    "",
    "Rules:",
    "- Quotes must be VERBATIM. Do not paraphrase or 'improve' wording.",
    "- Themes are short tags, not full phrases. 'pricing-mistakes' not 'common pricing mistakes founders make'.",
    "- Facts are concrete claims. 'Switched from $99/mo to $9/mo' is a fact; 'their pricing changed' is not.",
    "- Summary is 2-5 sentences. No marketing fluff.",
    "- Skip filler. If the source repeats itself, extract once.",
    "- Call submit_source_extraction exactly once. Do not respond with prose.",
  ].join("\n");
}

function buildUser(raw: RawSource): string {
  const trimmed = raw.text.length > MAX_INPUT_CHARS ? raw.text.slice(0, MAX_INPUT_CHARS) : raw.text;
  const lines: string[] = [];
  lines.push(`Source kind: ${raw.kind}`);
  if (raw.sourceUrl) lines.push(`Source URL: ${raw.sourceUrl}`);
  lines.push(`Source title (user-supplied or auto-extracted): ${raw.title}`);
  lines.push("");
  lines.push("Source content:");
  lines.push("---");
  lines.push(trimmed);
  if (raw.text.length > MAX_INPUT_CHARS) {
    lines.push("");
    lines.push(`[truncated at ${MAX_INPUT_CHARS} chars from a ${raw.text.length}-char source]`);
  }
  return lines.join("\n");
}

export async function extractFromSource(raw: RawSource): Promise<SourceExtractResult> {
  if (raw.text.trim().length < 100) {
    throw new Error("Source text is too short to extract from (need ≥100 chars).");
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: buildSystem(), cache_control: { type: "ephemeral" } }],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "submit_source_extraction" },
    messages: [{ role: "user", content: buildUser(raw) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_source_extraction") {
    throw new Error("Claude did not call submit_source_extraction.");
  }

  const parsed = extractedSourceSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Source extraction validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    extracted: parsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

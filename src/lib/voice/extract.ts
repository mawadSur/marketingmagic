import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { voiceProfileSchema, type VoiceProfileParsed } from "@/lib/voice/schema";

// Voice extractor — turns an array of reference posts into a structured
// VoiceProfile via Claude tool-use. Mirrors the pattern in
// src/app/(app)/settings/brief/actions.ts (suggestBriefFromUrlAction) and
// src/lib/plan/generate.ts exactly: same model, tool_choice forcing, no
// streaming, lazy singleton client.

const MODEL = "claude-sonnet-4-6";

// Bound how much text we send Claude. Reference posts beyond this are
// effectively ignored — at ~280 chars/X-post * 50 posts that's 14k chars,
// well under the bound. Long-form (LinkedIn essays) get truncated harder.
const MAX_POSTS = 25;
const MAX_TOTAL_CHARS = 20_000;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cachedClient;
}

export interface VoiceExtractInput {
  referencePosts: string[];
  // Optional context — the existing brief copy, used to disambiguate when
  // the reference posts alone don't make the brand obvious. Both fields
  // are optional; the prompt explains they are background, not exemplars.
  productDescription?: string;
  voiceHint?: string;
}

export interface VoiceExtractResult {
  profile: VoiceProfileParsed;
  usage: { input_tokens: number; output_tokens: number };
}

const VOICE_TOOL = {
  name: "submit_voice_profile",
  description:
    "Submit the extracted voice profile derived from the user's reference posts. " +
    "Call this exactly once. Be specific and grounded in the posts — quote distinctive " +
    "phrasing when it captures the register. Do not invent traits you cannot defend.",
  input_schema: {
    type: "object",
    required: [
      "vocabulary_signature",
      "opener_patterns",
      "sentence_length_avg",
      "formality",
      "emoji_usage",
      "punctuation_quirks",
      "do_not_say",
      "signature_phrases",
      "summary",
      "extracted_at",
      "source_count",
    ],
    properties: {
      vocabulary_signature: {
        type: "string",
        maxLength: 1000,
        description:
          "Lexical fingerprint: domain vocabulary, register-defining word choices, " +
          "what they say AS WELL AS what they avoid. 2-4 sentences.",
      },
      opener_patterns: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
        description: "How posts typically begin (e.g. 'shipped X', 'turns out Y').",
      },
      sentence_length_avg: {
        type: "number",
        minimum: 1,
        maximum: 80,
        description: "Average words per sentence across reference posts.",
      },
      formality: { type: "string", enum: ["casual", "neutral", "formal"] },
      emoji_usage: { type: "string", enum: ["none", "sparse", "frequent"] },
      punctuation_quirks: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
        description:
          "Distinctive punctuation habits (em-dashes, sentence fragments, " +
          "all-lowercase, etc.). Empty array if nothing distinctive.",
      },
      do_not_say: {
        type: "array",
        maxItems: 30,
        items: { type: "string", maxLength: 120 },
        description:
          "Words/phrases the brand avoids verbatim. Inferred from absence " +
          "and from any obvious negative signals in the posts.",
      },
      signature_phrases: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
        description: "Go-to phrases the brand uses repeatedly across reference posts.",
      },
      summary: {
        type: "string",
        maxLength: 800,
        description:
          "2-3 sentence prose summary of the voice. Should be specific enough that " +
          "another writer could mimic it without seeing the reference posts.",
      },
      extracted_at: {
        type: "string",
        description: "ISO 8601 UTC datetime when the extraction was performed.",
      },
      source_count: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Number of reference posts used as input.",
      },
    },
    additionalProperties: false,
  },
} as const;

function buildSystem(): string {
  return [
    "You are a voice analyst for marketingmagic.",
    "Your job: read a brand's reference posts and produce a structured voice profile",
    "specific enough that another writer could mimic the register without seeing the",
    "originals.",
    "",
    "Rules:",
    "- Be specific. 'Casual and friendly' is useless; 'lowercase sentence fragments,",
    "  ends with a one-word punchline' is useful.",
    "- Quote distinctive phrasing inside signature_phrases when you find it.",
    "- Infer do_not_say from absence — what register-defining words is the brand",
    "  visibly avoiding? Add 1-5 entries when confident.",
    "- Set source_count to the number of reference posts you actually used.",
    "- extracted_at must be the current UTC ISO 8601 timestamp.",
    "- Call submit_voice_profile exactly once. Do not respond with prose.",
  ].join("\n");
}

function buildUser(input: VoiceExtractInput, trimmed: string[]): string {
  const ctx: string[] = [];
  if (input.productDescription) {
    ctx.push(`Product context (background only, not a voice exemplar):`);
    ctx.push(input.productDescription.slice(0, 1000));
    ctx.push("");
  }
  if (input.voiceHint) {
    ctx.push(`Voice notes the user wrote (background, ground your profile in the posts):`);
    ctx.push(input.voiceHint.slice(0, 1000));
    ctx.push("");
  }
  return [
    ...ctx,
    `Reference posts (${trimmed.length}):`,
    ...trimmed.map((p, i) => `--- post ${i + 1} ---\n${p}`),
  ].join("\n");
}

function clampPosts(posts: string[]): string[] {
  const cleaned = posts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, MAX_POSTS);

  // Truncate from the tail of the array if total chars overrun the budget.
  // Keeping earlier posts preserves the "feel" of what the user pasted
  // first — usually their best examples.
  let totalChars = 0;
  const kept: string[] = [];
  for (const p of cleaned) {
    if (totalChars + p.length > MAX_TOTAL_CHARS) break;
    kept.push(p);
    totalChars += p.length;
  }
  return kept;
}

export async function extractVoiceProfile(
  input: VoiceExtractInput,
): Promise<VoiceExtractResult> {
  const trimmed = clampPosts(input.referencePosts);
  if (trimmed.length < 3) {
    throw new Error(
      `Need at least 3 reference posts to extract a voice profile (got ${trimmed.length}).`,
    );
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: "text", text: buildSystem(), cache_control: { type: "ephemeral" } }],
    tools: [VOICE_TOOL],
    tool_choice: { type: "tool", name: "submit_voice_profile" },
    messages: [{ role: "user", content: buildUser(input, trimmed) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_voice_profile") {
    throw new Error("Claude did not call submit_voice_profile.");
  }

  // Force-correct extracted_at + source_count — Claude is allowed to be
  // wrong about these and the schema would let it slide; we own ground
  // truth for both.
  const raw = toolUse.input as Record<string, unknown>;
  const fixed = {
    ...raw,
    extracted_at: new Date().toISOString(),
    source_count: trimmed.length,
  };

  const parsed = voiceProfileSchema.safeParse(fixed);
  if (!parsed.success) {
    throw new Error(
      `Voice profile validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    profile: parsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

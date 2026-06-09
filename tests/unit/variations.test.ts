import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Unit: Hook×body variation generator + lineage (Hormozi slices #3+#4) ─────
//
// Covers the four contracts the variation engine pins down:
//   1. Prompt — the source text + the Hormozi ORGANIC mechanic (hook-first,
//      varied visual+spoken hooks, text-overlay CTA, organic-native) land in
//      the system prompt; the user prompt states the exact hook/body counts.
//   2. Schema/assembly — the cross product is N×M (default 10×3=30), indices
//      trace back into the matrix, full_text composes the filmable script, and
//      the matrix schema enforces its bounds.
//   3. Generator — with a mocked Claude tool call, generateVariationMatrix
//      returns exactly 10×3=30 assembled variations.
//   4. Lineage — when the variations are persisted, every draft carries
//      parent_post_id = the source id AND a single shared variation_group_id.

// ── Mocks. Env so serverEnv() doesn't demand a real key; the Anthropic SDK so
//    the generator runs against a canned tool response (pure, offline). ────────
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ ANTHROPIC_API_KEY: "test-key" }),
}));

// The mock Claude reply: 10 hooks + 3 bodies, each distinct, via a forced
// submit_variation_matrix tool call.
const HOOKS = Array.from({ length: 10 }, (_, i) => ({
  spoken: `Spoken hook ${i}`,
  visual: `Visual interrupt ${i}`,
}));
const BODIES = Array.from({ length: 3 }, (_, i) => ({
  spoken: `Body payload ${i}`,
  cta_overlay: `CTA ${i}`,
}));

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import {
  variationSystemPrompt,
  variationUserPrompt,
  type VariationSeed,
} from "@/lib/variations/prompt";
import {
  assembleVariations,
  composeFullText,
  variationMatrixSchema,
  DEFAULT_BODIES,
  DEFAULT_HOOKS,
} from "@/lib/variations/schema";
import { generateVariationMatrix } from "@/lib/variations/generate";

const SEED: VariationSeed = {
  text: "We dropped our price from $99 to $9 and churn fell 50% in a quarter.",
  theme: "pricing-mistakes",
};

function mockMatrixReply() {
  messagesCreate.mockResolvedValue({
    content: [
      {
        type: "tool_use",
        name: "submit_variation_matrix",
        input: {
          overview: "Reframed the pricing-cut story across 10 hooks and 3 bodies.",
          hooks: HOOKS,
          bodies: BODIES,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 200 },
  });
}

beforeEach(() => {
  mockMatrixReply();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("variationSystemPrompt", () => {
  it("encodes the Hormozi organic mechanic and the theme", () => {
    const sys = variationSystemPrompt(SEED);
    expect(sys).toMatch(/HOOK-FIRST/i);
    // Varied visual + spoken hooks.
    expect(sys).toMatch(/visual hook/i);
    expect(sys).toMatch(/spoken hook/i);
    // Text-overlay CTA, never spoken.
    expect(sys).toMatch(/TEXT OVERLAY/i);
    expect(sys).toMatch(/never spoken/i);
    // Organic-native feel.
    expect(sys).toMatch(/organic-native/i);
    // Theme carries through.
    expect(sys).toContain("pricing-mistakes");
  });

  it("includes the voice profile only when the brief carries one", () => {
    expect(variationSystemPrompt(SEED)).not.toContain("Voice profile");
    const withVoice = variationSystemPrompt({
      ...SEED,
      voiceProfile: {
        vocabulary_signature: "short, declarative",
        opener_patterns: ["Here's the thing —"],
        sentence_length_avg: 12,
        formality: "casual",
        emoji_usage: "none",
        punctuation_quirks: ["em-dash"],
        do_not_say: ["circle back"],
        signature_phrases: ["ship it"],
        summary: "Terse, founder-to-founder.",
        extracted_at: "2026-01-01T00:00:00Z",
        source_count: 20,
      },
    });
    expect(withVoice).toContain("Voice profile");
    expect(withVoice).toContain("Terse, founder-to-founder.");
  });
});

describe("variationUserPrompt", () => {
  it("states the exact hook and body counts and grounds in the source", () => {
    const user = variationUserPrompt(SEED, 10, 3);
    expect(user).toContain("exactly 10 HOOKS");
    expect(user).toContain("exactly 3 BODIES");
    expect(user).toContain("price from $99 to $9");
    expect(user).toContain("submit_variation_matrix");
  });
});

describe("assembleVariations + composeFullText", () => {
  it("produces the full N×M cross product (10×3 = 30) with traceable indices", () => {
    const matrix = { overview: "x", hooks: HOOKS, bodies: BODIES };
    const variations = assembleVariations(matrix);
    expect(variations).toHaveLength(DEFAULT_HOOKS * DEFAULT_BODIES);
    expect(variations).toHaveLength(30);

    // Every (hook, body) pair appears exactly once.
    const pairs = new Set(variations.map((v) => `${v.hook_index}-${v.body_index}`));
    expect(pairs.size).toBe(30);

    // Indices map back into the source matrix.
    for (const v of variations) {
      expect(v.hook).toEqual(HOOKS[v.hook_index]);
      expect(v.body).toEqual(BODIES[v.body_index]);
    }
  });

  it("composes a filmable script: visual cue, spoken hook, body, CTA overlay", () => {
    const text = composeFullText(HOOKS[0], BODIES[0]);
    expect(text).toContain("[ON-SCREEN: Visual interrupt 0]");
    expect(text).toContain("Spoken hook 0");
    expect(text).toContain("Body payload 0");
    expect(text).toContain("[CTA OVERLAY: CTA 0]");
    // CTA cue comes after the body (overlay, not spoken-up-front).
    expect(text.indexOf("Body payload 0")).toBeLessThan(text.indexOf("CTA OVERLAY"));
  });
});

describe("variationMatrixSchema", () => {
  it("accepts a well-formed 10×3 matrix", () => {
    const parsed = variationMatrixSchema.safeParse({
      overview: "ok",
      hooks: HOOKS,
      bodies: BODIES,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects too few hooks (below MIN_HOOKS)", () => {
    const parsed = variationMatrixSchema.safeParse({
      overview: "ok",
      hooks: [HOOKS[0]],
      bodies: BODIES,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects too many bodies (above MAX_BODIES)", () => {
    const parsed = variationMatrixSchema.safeParse({
      overview: "ok",
      hooks: HOOKS,
      bodies: Array.from({ length: 6 }, (_, i) => ({ spoken: `b${i}`, cta_overlay: `c${i}` })),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("generateVariationMatrix (mocked Claude)", () => {
  it("forces the tool call and returns exactly 10×3 = 30 variations by default", async () => {
    const result = await generateVariationMatrix(SEED);
    expect(messagesCreate).toHaveBeenCalledOnce();
    // tool_choice forced the single submit call.
    const call = messagesCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "submit_variation_matrix" });
    expect(call.model).toBe("claude-opus-4-8");

    expect(result.hookCount).toBe(DEFAULT_HOOKS);
    expect(result.bodyCount).toBe(DEFAULT_BODIES);
    expect(result.variations).toHaveLength(30);
    expect(result.usage.output_tokens).toBe(200);
  });

  it("rejects empty source text at the boundary (no Claude call)", async () => {
    await expect(generateVariationMatrix({ text: "   ", theme: null })).rejects.toThrow(/empty/i);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range matrix request at the boundary", async () => {
    await expect(generateVariationMatrix(SEED, { hooks: 99 })).rejects.toThrow(/2-12/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

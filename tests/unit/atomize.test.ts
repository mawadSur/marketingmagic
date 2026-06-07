import { describe, it, expect } from "vitest";
import { atomizeSystemPrompt, atomizeUserPrompt, type AtomizeInputs } from "@/lib/atomize/prompt";
import { atomizationSchema } from "@/lib/atomize/schema";
import type { Database } from "@/lib/db/types";
import type { SourceContext } from "@/lib/plan/prompt";
import { CHANNELS } from "@/lib/channels/registry";

// ── Unit: Atomization prompt + schema (Bet 2 — Atomization Engine) ───────────
//
// Pure functions only — no Anthropic SDK, no Supabase. Covers the three
// contracts the atomizer pins down:
//   1. Prompt grounding — the source title/summary/quotes/facts + the active
//      channel caps land in the system prompt; the user prompt restricts the
//      channel enum to the connected set.
//   2. Voice gating — a voice_score instruction appears only when the brief
//      carries a voice_profile (mirrors the planner).
//   3. Schema — atomizationSchema accepts a well-formed submit_atomization
//      payload, enforces the REUSED per-channel cap (planVariantSchema), and
//      drops empty text on non-skipped variants.

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    id: "brief-1",
    workspace_id: "ws-1",
    product_description: "A scheduling tool for indie founders.",
    voice: "Plain-spoken, specific, no hype.",
    target_audience: "Solo founders shipping their first SaaS.",
    do_not_say: ["synergy", "leverage"],
    reference_links: [],
    reference_posts: [],
    voice_profile: null,
    voice_profile_extracted_at: null,
    pending_voice_diff: null,
    pending_voice_diff_at: null,
    audience_timezone: "UTC",
    theme_snooze: [],
    theme_gaps_enabled: true,
    audio_retention_opt_in: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Brief;
}

const SOURCE: SourceContext = {
  title: "How we cut churn in half",
  summary: "We dropped our price from $99 to $9 and churn fell 50% in a quarter.",
  themes: ["pricing-mistakes", "churn"],
  quotes: [{ text: "We were charging for features nobody used.", speaker: "Founder" }],
  facts: [{ text: "Switched from $99/mo to $9/mo", context: "Q2 2025" }],
  sourceUrl: "https://example.com/post",
};

function makeInputs(overrides: Partial<AtomizeInputs> = {}): AtomizeInputs {
  return {
    brief: makeBrief(),
    source: SOURCE,
    channels: ["x", "linkedin", "bluesky"],
    atomTarget: 8,
    ...overrides,
  };
}

describe("atomizeSystemPrompt", () => {
  it("grounds the prompt in the source and only the active channels' caps", () => {
    const sys = atomizeSystemPrompt(makeInputs());
    // Source material is surfaced.
    expect(sys).toContain("How we cut churn in half");
    expect(sys).toContain("We dropped our price from $99 to $9");
    expect(sys).toContain("We were charging for features nobody used.");
    expect(sys).toContain("Switched from $99/mo to $9/mo");
    expect(sys).toContain("pricing-mistakes");
    // Active-channel caps appear; an inactive channel's cap does not.
    expect(sys).toContain(`X: ≤ ${CHANNELS.x.maxChars} chars`);
    expect(sys).toContain(`LinkedIn: ≤ ${CHANNELS.linkedin.maxChars} chars`);
    expect(sys).not.toContain("Instagram: ≤");
    // Brand do-not-say carries through.
    expect(sys).toContain("synergy");
  });

  it("includes the LinkedIn long-form block only when LinkedIn is connected", () => {
    expect(atomizeSystemPrompt(makeInputs({ channels: ["x", "linkedin"] }))).toContain(
      "LinkedIn long-form guidance",
    );
    expect(atomizeSystemPrompt(makeInputs({ channels: ["x", "bluesky"] }))).not.toContain(
      "LinkedIn long-form guidance",
    );
  });

  it("asks for a voice_score only when the brief has a voice_profile", () => {
    expect(atomizeSystemPrompt(makeInputs())).not.toContain("voice_score");

    const withProfile = makeInputs({
      brief: makeBrief({
        voice_profile: {
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
      }),
    });
    const sys = atomizeSystemPrompt(withProfile);
    expect(sys).toContain("voice_score");
    expect(sys).toContain("Terse, founder-to-founder.");
  });
});

describe("atomizeUserPrompt", () => {
  it("restricts variants to the connected channels and states the atom target", () => {
    const user = atomizeUserPrompt(makeInputs({ atomTarget: 12, channels: ["x", "threads"] }));
    expect(user).toContain("~12 atoms");
    expect(user).toContain("x, threads");
    expect(user).toContain("submit_atomization");
  });
});

describe("atomizationSchema", () => {
  const validPayload = {
    overview: "Decomposed the churn post into pricing, retention, and process angles.",
    atoms: [
      {
        atom_label: "The price was the problem",
        theme: "pricing-mistakes",
        variants: [
          {
            channel: "x",
            text: "We charged $99 for features nobody used. Dropped to $9. Churn fell 50%.",
            rationale: "Punchy stat-led hook fits X.",
            voice_score: 82,
          },
          {
            channel: "linkedin",
            text: "Here's the uncomfortable truth about our pricing: we were charging $99/mo for a product most users only touched a fraction of. We cut it to $9. Churn fell 50% in a quarter. The lesson wasn't 'charge less' — it was 'charge for what people actually use.'",
            rationale: "LinkedIn rewards the developed argument.",
            voice_score: 88,
          },
        ],
      },
    ],
  };

  it("accepts a well-formed submit_atomization payload", () => {
    const parsed = atomizationSchema.safeParse(validPayload);
    expect(parsed.success).toBe(true);
  });

  it("enforces the reused per-channel cap (X = 280) from planVariantSchema", () => {
    const tooLong = {
      ...validPayload,
      atoms: [
        {
          ...validPayload.atoms[0],
          variants: [
            {
              channel: "x",
              text: "x".repeat(CHANNELS.x.maxChars + 1),
              rationale: "over the X cap",
            },
          ],
        },
      ],
    };
    const parsed = atomizationSchema.safeParse(tooLong);
    expect(parsed.success).toBe(false);
  });

  it("allows empty text only when the variant is skipped", () => {
    const skipped = {
      ...validPayload,
      atoms: [
        {
          ...validPayload.atoms[0],
          variants: [
            { channel: "instagram", text: "", skip: true, rationale: "no visual to anchor on" },
          ],
        },
      ],
    };
    expect(atomizationSchema.safeParse(skipped).success).toBe(true);

    const emptyNotSkipped = {
      ...validPayload,
      atoms: [
        {
          ...validPayload.atoms[0],
          variants: [{ channel: "x", text: "   ", rationale: "blank body" }],
        },
      ],
    };
    expect(atomizationSchema.safeParse(emptyNotSkipped).success).toBe(false);
  });

  it("requires at least one atom", () => {
    expect(atomizationSchema.safeParse({ overview: "x", atoms: [] }).success).toBe(false);
  });
});

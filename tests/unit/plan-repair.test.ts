import { describe, expect, it } from "vitest";
import { repairPlanInput, planSchema } from "@/lib/plan/schema";

// ── Unit: repairPlanInput (src/lib/plan/schema.ts) ───────────────────────────
//
// The plan generator forces a tool call but the model can still slip on two
// recoverable rules that used to nuke the WHOLE plan with "Plan validation
// failed": (1) an overview over the 800-char cap, (2) a variant left with empty
// text and skip unset. repairPlanInput coerces both BEFORE validation so a good
// plan survives, while the schema stays strict for genuinely-broken output.

// A minimal valid idea variant (filled).
function filledVariant(channel = "x") {
  return { channel, text: "A real post body.", rationale: "Fits the channel.", skip: false };
}

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    plan_name: "Launch week",
    overview: "A tight overview.",
    ideas: [
      {
        idea_label: "Behind the scenes",
        theme: "behind-the-scenes",
        suggested_scheduled_at: "2026-06-12T14:00:00.000Z",
        variants: [filledVariant("x")],
      },
    ],
    ...overrides,
  };
}

describe("repairPlanInput: over-long overview", () => {
  it("truncates an overview beyond 800 chars to fit (with ellipsis)", () => {
    const long = "x".repeat(900);
    const out = repairPlanInput(basePlan({ overview: long })) as { overview: string };
    expect(out.overview.length).toBeLessThanOrEqual(800);
    expect(out.overview.endsWith("…")).toBe(true);
  });

  it("leaves a within-cap overview untouched", () => {
    const out = repairPlanInput(basePlan({ overview: "Short." })) as { overview: string };
    expect(out.overview).toBe("Short.");
  });
});

describe("repairPlanInput: empty non-skipped variant → skip:true", () => {
  it("coerces skip:true + a default rationale when text is empty and skip is false", () => {
    const plan = basePlan({
      ideas: [
        {
          idea_label: "Idea",
          theme: "t",
          suggested_scheduled_at: "2026-06-12T14:00:00.000Z",
          variants: [
            filledVariant("x"),
            { channel: "linkedin", text: "   ", rationale: "n/a", skip: false },
          ],
        },
      ],
    });
    const out = repairPlanInput(plan) as {
      ideas: Array<{ variants: Array<{ skip?: boolean; text: string }> }>;
    };
    const linkedin = out.ideas[0].variants[1];
    expect(linkedin.skip).toBe(true);
  });

  it("preserves an existing rationale when coercing skip", () => {
    const plan = basePlan({
      ideas: [
        {
          idea_label: "Idea",
          theme: "t",
          suggested_scheduled_at: "2026-06-12T14:00:00.000Z",
          variants: [{ channel: "x", text: "", rationale: "Too long for X.", skip: false }],
        },
      ],
    });
    const out = repairPlanInput(plan) as {
      ideas: Array<{ variants: Array<{ skip?: boolean; rationale: string }> }>;
    };
    expect(out.ideas[0].variants[0].skip).toBe(true);
    expect(out.ideas[0].variants[0].rationale).toBe("Too long for X.");
  });

  it("does NOT touch a filled variant or an already-skipped one", () => {
    const plan = basePlan({
      ideas: [
        {
          idea_label: "Idea",
          theme: "t",
          suggested_scheduled_at: "2026-06-12T14:00:00.000Z",
          variants: [
            filledVariant("x"),
            { channel: "bluesky", text: "", rationale: "skip me", skip: true },
          ],
        },
      ],
    });
    const out = repairPlanInput(plan) as {
      ideas: Array<{ variants: Array<{ skip?: boolean }> }>;
    };
    expect(out.ideas[0].variants[0].skip).toBe(false); // filled — untouched
    expect(out.ideas[0].variants[1].skip).toBe(true); // already skipped
  });
});

describe("repairPlanInput: the repaired plan actually validates", () => {
  it("a previously-failing plan (long overview + empty non-skipped variant) passes after repair", () => {
    const broken = basePlan({
      overview: "y".repeat(1200),
      ideas: [
        {
          idea_label: "Compare competitors",
          theme: "competitive",
          suggested_scheduled_at: "2026-06-12T14:00:00.000Z",
          variants: [
            filledVariant("x"),
            { channel: "instagram", text: "", rationale: "n/a", skip: false },
          ],
        },
      ],
    });
    // Sanity: the RAW input fails (mirrors the reported bug).
    expect(planSchema.safeParse(broken).success).toBe(false);
    // After repair it validates.
    expect(planSchema.safeParse(repairPlanInput(broken)).success).toBe(true);
  });
});

describe("repairPlanInput: defensive pass-through", () => {
  it("returns non-objects untouched and never throws", () => {
    expect(repairPlanInput(null)).toBeNull();
    expect(repairPlanInput("nope")).toBe("nope");
    expect(repairPlanInput([1, 2])).toEqual([1, 2]);
  });
});

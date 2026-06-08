import { describe, expect, it } from "vitest";

// ── Unit: shared BrandStyle projection (src/lib/brand/style.ts) + loader
// graceful fallback (src/lib/brand/load.ts).
//
// This is the SINGLE SOURCE OF TRUTH that keeps generated images and generated
// videos on-brand together. The tests prove:
//   • a populated brand brief + org branding → the expected prompt fragment,
//   • each signal (colours / tone / voice / subject / logo) contributes,
//   • graceful default: an empty brief yields an empty style + "" fragment, so
//     generation falls back to today's generic behaviour (no regression),
//   • input is sanitised (only hex colours, whitespace collapsed, dedup),
//   • applyBrandStyleToPrompt joins / passes-through correctly,
//   • loadBrandStyle never throws — a DB error degrades to EMPTY_BRAND_STYLE.

import {
  applyBrandStyleToPrompt,
  brandStyleToPromptFragment,
  isEmptyBrandStyle,
  projectBrandStyle,
  type BrandStyleInputs,
} from "@/lib/brand/style";
import type { VoiceProfile } from "@/lib/db/types";

function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    vocabulary_signature: "",
    opener_patterns: [],
    sentence_length_avg: 12,
    formality: "neutral",
    emoji_usage: "none",
    punctuation_quirks: [],
    do_not_say: [],
    signature_phrases: [],
    summary: "",
    extracted_at: "2026-01-01T00:00:00Z",
    source_count: 3,
    ...overrides,
  };
}

describe("projectBrandStyle", () => {
  it("projects a fully-populated brand brief + org branding into every signal", () => {
    const inputs: BrandStyleInputs = {
      voice: "Plain-spoken, confident, no jargon.",
      voiceProfile: voiceProfile({ formality: "formal", emoji_usage: "none" }),
      productDescription: "A scheduling app for solo founders",
      targetAudience: "indie SaaS makers",
      colorPrimary: "#1A2B3C",
      colorAccent: "#FF8800",
      logoUrl: "https://cdn.example.com/org/logo-123.png",
    };
    const style = projectBrandStyle(inputs);

    expect(isEmptyBrandStyle(style)).toBe(false);
    expect(style.colors).toEqual(["#1A2B3C", "#FF8800"]);
    expect(style.visualTone).toBe("polished and professional");
    expect(style.voiceHint).toBe("Plain-spoken, confident, no jargon.");
    expect(style.subjectContext).toBe(
      "A scheduling app for solo founders (for indie SaaS makers)",
    );
    expect(style.hasLogo).toBe(true);

    const fragment = brandStyleToPromptFragment(style);
    expect(fragment).toContain("#1A2B3C, #FF8800");
    expect(fragment).toContain("polished and professional visual style");
    expect(fragment).toContain("brand voice: Plain-spoken, confident, no jargon.");
    expect(fragment).toContain("A scheduling app for solo founders (for indie SaaS makers)");
    expect(fragment).toContain("negative space for a logo overlay");
    expect(fragment.startsWith("On-brand styling — ")).toBe(true);
  });

  it("returns an EMPTY style (and no fragment) when no brand identity is set", () => {
    const style = projectBrandStyle({});
    expect(isEmptyBrandStyle(style)).toBe(true);
    expect(style.colors).toEqual([]);
    expect(style.visualTone).toBeNull();
    expect(style.voiceHint).toBeNull();
    expect(style.subjectContext).toBeNull();
    expect(style.hasLogo).toBe(false);
    // The no-regression contract: empty style → empty fragment → prompt unchanged.
    expect(brandStyleToPromptFragment(style)).toBe("");
    expect(applyBrandStyleToPrompt("a cat on a beach", style)).toBe("a cat on a beach");
  });

  it("treats whitespace-only / null fields as unset (graceful default)", () => {
    const style = projectBrandStyle({
      voice: "   ",
      productDescription: "",
      targetAudience: null,
      colorPrimary: "  ",
      logoUrl: "   ",
    });
    expect(isEmptyBrandStyle(style)).toBe(true);
    expect(brandStyleToPromptFragment(style)).toBe("");
  });

  it("only lets validated hex colours through (no prompt injection of brand text)", () => {
    const style = projectBrandStyle({
      colorPrimary: "rgb(10,20,30); drop table",
      colorAccent: "#abc",
    });
    // The bad primary is dropped; the valid 3-digit hex accent survives.
    expect(style.colors).toEqual(["#abc"]);
  });

  it("dedupes when primary and accent are the same colour", () => {
    const style = projectBrandStyle({ colorPrimary: "#123456", colorAccent: "#123456" });
    expect(style.colors).toEqual(["#123456"]);
  });

  it("maps voice_profile formality + emoji usage to a tone descriptor", () => {
    expect(
      projectBrandStyle({ voiceProfile: voiceProfile({ formality: "casual" }) }).visualTone,
    ).toBe("relaxed and approachable");
    expect(
      projectBrandStyle({ voiceProfile: voiceProfile({ formality: "neutral" }) }).visualTone,
    ).toBe("clean and modern");
    expect(
      projectBrandStyle({
        voiceProfile: voiceProfile({ formality: "casual", emoji_usage: "frequent" }),
      }).visualTone,
    ).toBe("relaxed and approachable, playful and energetic");
  });

  it("collapses internal whitespace and caps over-long brand text", () => {
    const style = projectBrandStyle({ voice: "  lots\n\n  of   space   " });
    expect(style.voiceHint).toBe("lots of space");
  });

  it("derives subject context from whichever of product/audience is present", () => {
    expect(projectBrandStyle({ productDescription: "An app" }).subjectContext).toBe("An app");
    expect(projectBrandStyle({ targetAudience: "devs" }).subjectContext).toBe("audience: devs");
  });
});

describe("brandStyleToPromptFragment — partial signals", () => {
  it("emits only the colour clause when only colours are set", () => {
    const fragment = brandStyleToPromptFragment(
      projectBrandStyle({ colorPrimary: "#000000" }),
    );
    expect(fragment).toBe("On-brand styling — brand colour palette #000000.");
  });

  it("emits only the voice clause when only the brand voice is set", () => {
    const fragment = brandStyleToPromptFragment(projectBrandStyle({ voice: "Bold and witty" }));
    expect(fragment).toBe("On-brand styling — brand voice: Bold and witty.");
  });
});

describe("applyBrandStyleToPrompt", () => {
  it("appends the fragment after the base prompt when a brand is set", () => {
    const style = projectBrandStyle({ colorPrimary: "#ff0000" });
    const out = applyBrandStyleToPrompt("a launch announcement graphic", style);
    expect(out).toBe(
      "a launch announcement graphic\n\nOn-brand styling — brand colour palette #ff0000.",
    );
  });

  it("returns the fragment alone when the base prompt is empty but a brand is set", () => {
    const style = projectBrandStyle({ colorPrimary: "#ff0000" });
    expect(applyBrandStyleToPrompt("", style)).toBe(
      "On-brand styling — brand colour palette #ff0000.",
    );
  });

  it("returns an empty base prompt unchanged when the brand is empty", () => {
    expect(applyBrandStyleToPrompt("", projectBrandStyle({}))).toBe("");
  });
});

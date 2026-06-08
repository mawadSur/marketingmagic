import { describe, it, expect } from "vitest";
import {
  normalizeTags,
  tagBoundsForChannel,
  mergeAndCap,
} from "@/lib/tags/generate";
import { getChannelHashtagPolicy } from "@/lib/hashtags/rules";
import type { ChannelId } from "@/lib/channels/registry";

// ── Unit: auto-tag generator pure helpers (migration 052) ────────────────────
//
// Covers the three contracts the generation layer pins down WITHOUT touching
// the Anthropic SDK or Supabase (those are exercised in the persist/action
// integration paths, mirroring how atomize.test.ts unit-tests the planner's
// pure functions):
//   1. normalizeTags — lowercase, strip leading #, ASCII-only, dedupe, drop
//      empties / over-length.
//   2. tagBoundsForChannel — reads the channel policy as the single gate:
//      disabled (0 tags) for Bluesky, X defaults to target 0 / max 1, the
//      tag-friendly channels carry their policy bounds.
//   3. mergeAndCap — blends recommended (priority) + llm tags, normalizes,
//      caps to the channel max, returns [] for no-tag channels.

describe("normalizeTags", () => {
  it("lowercases, strips leading #, and dedupes preserving first-seen order", () => {
    expect(normalizeTags(["#BuildInPublic", "buildinpublic", "#Launch"]))
      .toEqual(["buildinpublic", "launch"]);
  });

  it("strips multiple leading hashes and trims whitespace", () => {
    expect(normalizeTags(["  ##Founder  ", "#startup"]))
      .toEqual(["founder", "startup"]);
  });

  it("drops non-ASCII / punctuated tags the platforms would reject", () => {
    // hyphen, space, emoji, and a unicode letter all fail [a-z0-9_]+.
    expect(normalizeTags(["build-in-public", "two words", "🚀rocket", "café"]))
      .toEqual([]);
    // underscore + digits survive.
    expect(normalizeTags(["build_in_public", "web3"]))
      .toEqual(["build_in_public", "web3"]);
  });

  it("drops empty and over-length tags", () => {
    const tooLong = "a".repeat(101);
    expect(normalizeTags(["", "#", "   ", tooLong, "ok"])).toEqual(["ok"]);
  });
});

describe("tagBoundsForChannel", () => {
  it("disables tags entirely for Bluesky (0 tags, no chips)", () => {
    const b = tagBoundsForChannel("bluesky");
    expect(b.enabled).toBe(false);
    expect(b.max).toBe(0);
    expect(b.target).toBe(0);
  });

  it("defaults X to target 0 (empty) with a hard cap of 1", () => {
    const b = tagBoundsForChannel("x");
    expect(b.enabled).toBe(true);
    expect(b.target).toBe(0);
    expect(b.max).toBe(1);
  });

  it("mirrors the rules.ts policy bounds for tag-friendly channels", () => {
    for (const ch of ["linkedin", "threads", "instagram", "facebook", "tiktok"] as ChannelId[]) {
      const policy = getChannelHashtagPolicy(ch);
      const b = tagBoundsForChannel(ch);
      expect(b.max).toBe(Math.min(policy.recommendedCount[1], 30));
      expect(b.target).toBeLessThanOrEqual(b.max);
    }
  });
});

describe("mergeAndCap", () => {
  it("returns [] for no-tag channels regardless of inputs", () => {
    expect(mergeAndCap("bluesky", ["startup", "founders"], ["building"])).toEqual([]);
  });

  it("never exceeds the channel cap (LinkedIn = 3)", () => {
    const out = mergeAndCap(
      "linkedin",
      ["startup", "founders", "buildinpublic"],
      ["marketing", "growth", "saas"],
    );
    expect(out.length).toBe(3);
  });

  it("respects X's hard cap of 1", () => {
    const out = mergeAndCap("x", ["indiehackers"], ["buildinpublic", "startup"]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe("indiehackers");
  });

  it("prioritizes recommended (workspace history) ahead of LLM-invented tags", () => {
    // LinkedIn cap is 3; recommended fills the first slots.
    const out = mergeAndCap(
      "linkedin",
      ["proventag1", "proventag2"],
      ["llmtag1", "llmtag2", "llmtag3"],
    );
    expect(out).toEqual(["proventag1", "proventag2", "llmtag1"]);
  });

  it("normalizes and dedupes across both sources before capping", () => {
    // "#Startup" (recommended) and "startup" (llm) collapse to one tag.
    const out = mergeAndCap("instagram", ["#Startup"], ["startup", "#Founder", "founder"]);
    expect(out).toEqual(["startup", "founder"]);
  });

  it("Instagram allows a richer mix (up to policy max 15)", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const out = mergeAndCap("instagram", [], many);
    expect(out.length).toBe(getChannelHashtagPolicy("instagram").recommendedCount[1]);
  });
});

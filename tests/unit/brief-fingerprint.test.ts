import { describe, expect, it } from "vitest";
import {
  briefContentFingerprint,
  isPostStaleForBrief,
  postBriefFingerprint,
} from "@/lib/brand/fingerprint";

// ── Unit: brand/fingerprint.ts ────────────────────────────────────────────────
//
// briefContentFingerprint must be:
//   • stable     — identical content → identical hash
//   • sensitive  — any generation-relevant field change → different hash
//   • order-free — reordering array fields (do_not_say, reference_*) → same hash
//   • noise-free — re-extraction metadata (extracted_at, source_count) → same hash

type Brief = Parameters<typeof briefContentFingerprint>[0];

const base: Brief = {
  product_description: "An AI marketing copilot for solo founders.",
  voice: "Direct, witty, build-in-public.",
  target_audience: "Indie hackers shipping in public.",
  do_not_say: ["synergy", "leverage"],
  reference_links: ["https://a.com", "https://b.com"],
  reference_posts: ["Shipped v2 today.", "Numbers don't lie."],
  voice_profile: null,
};

const voiceProfile = {
  vocabulary_signature: "short punchy",
  opener_patterns: ["Today", "Here's"],
  sentence_length_avg: 9.2,
  formality: "casual" as const,
  emoji_usage: "sparse" as const,
  punctuation_quirks: ["em-dash"],
  do_not_say: ["circle back"],
  signature_phrases: ["ship it"],
  summary: "Punchy founder voice.",
  extracted_at: "2026-06-01T00:00:00.000Z",
  source_count: 12,
};

describe("briefContentFingerprint", () => {
  it("is stable for identical content", () => {
    expect(briefContentFingerprint(base)).toBe(briefContentFingerprint({ ...base }));
  });

  it("returns a 16-char hex string", () => {
    expect(briefContentFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when product_description changes", () => {
    expect(briefContentFingerprint({ ...base, product_description: "Different." })).not.toBe(
      briefContentFingerprint(base),
    );
  });

  it("changes when voice changes", () => {
    expect(briefContentFingerprint({ ...base, voice: "Formal and corporate." })).not.toBe(
      briefContentFingerprint(base),
    );
  });

  it("changes when target_audience changes", () => {
    expect(briefContentFingerprint({ ...base, target_audience: "Enterprise CMOs." })).not.toBe(
      briefContentFingerprint(base),
    );
  });

  it("changes when do_not_say gains a phrase", () => {
    expect(briefContentFingerprint({ ...base, do_not_say: ["synergy", "leverage", "growth-hack"] })).not.toBe(
      briefContentFingerprint(base),
    );
  });

  it("is insensitive to do_not_say ordering", () => {
    expect(briefContentFingerprint({ ...base, do_not_say: ["leverage", "synergy"] })).toBe(
      briefContentFingerprint(base),
    );
  });

  it("is insensitive to reference_posts ordering", () => {
    expect(
      briefContentFingerprint({ ...base, reference_posts: ["Numbers don't lie.", "Shipped v2 today."] }),
    ).toBe(briefContentFingerprint(base));
  });

  it("changes when a voice_profile is attached", () => {
    expect(briefContentFingerprint({ ...base, voice_profile: voiceProfile })).not.toBe(
      briefContentFingerprint(base),
    );
  });

  it("changes when a voice_profile substance field changes", () => {
    const changed = { ...voiceProfile, formality: "formal" as const };
    expect(briefContentFingerprint({ ...base, voice_profile: changed })).not.toBe(
      briefContentFingerprint({ ...base, voice_profile: voiceProfile }),
    );
  });

  it("ignores voice_profile provenance metadata (extracted_at, source_count)", () => {
    const reExtracted = {
      ...voiceProfile,
      extracted_at: "2026-12-31T23:59:59.000Z",
      source_count: 99,
    };
    expect(briefContentFingerprint({ ...base, voice_profile: reExtracted })).toBe(
      briefContentFingerprint({ ...base, voice_profile: voiceProfile }),
    );
  });

  it("does not throw on null / partial briefs", () => {
    expect(() => briefContentFingerprint(null)).not.toThrow();
    expect(briefContentFingerprint(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("postBriefFingerprint", () => {
  it("reads a stamped fingerprint", () => {
    expect(postBriefFingerprint({ brief_fingerprint: "abc123" })).toBe("abc123");
  });
  it("returns null for missing / non-string / empty", () => {
    expect(postBriefFingerprint(null)).toBeNull();
    expect(postBriefFingerprint({})).toBeNull();
    expect(postBriefFingerprint({ brief_fingerprint: 42 })).toBeNull();
    expect(postBriefFingerprint({ brief_fingerprint: "" })).toBeNull();
  });
});

describe("isPostStaleForBrief", () => {
  const current = briefContentFingerprint(base);

  it("flags a post stamped with a different fingerprint", () => {
    expect(isPostStaleForBrief({ brief_fingerprint: "deadbeefdeadbeef" }, current)).toBe(true);
  });

  it("does NOT flag a post stamped with the current fingerprint", () => {
    expect(isPostStaleForBrief({ brief_fingerprint: current }, current)).toBe(false);
  });

  it("does NOT flag a post with no stamped fingerprint (legacy / hand-composed)", () => {
    expect(isPostStaleForBrief({ source: "compose" }, current)).toBe(false);
    expect(isPostStaleForBrief(null, current)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizeContent,
  hashContent,
  contentTrigrams,
  jaccard,
  similarity,
  isNearDuplicate,
  compileText,
  similarityCompiled,
  isNearDuplicateCompiled,
  NEAR_DUP_THRESHOLD,
} from "@/lib/dedup/similarity";

// ── Content dedup — the pure similarity layer ────────────────────────────────
//
// These exercise the deterministic, I/O-free half of dedup: normalisation,
// the EXACT-match content hash, and NEAR-match trigram-Jaccard similarity.
// Everything here is a pure function of its arguments (no DB, no clock), so we
// can pin concrete inputs and assert exact outputs. The classifier itself
// (verdict thresholds against a corpus) lives in the gate and is tested there;
// here we only prove the scoring behaves.

describe("normalizeContent", () => {
  it("lowercases, strips accents, URLs, @mentions, #hashtags, emoji, and collapses whitespace", () => {
    const out = normalizeContent(
      "Café  #growth @bob 🚀 visit https://example.com/x?y=1 NOW!!!",
    );
    // Accents folded (café→cafe), hashtag + mention + emoji + URL gone,
    // punctuation stripped, whitespace collapsed.
    expect(out).toBe("cafe visit now");
  });

  it("treats two posts differing only by a trailing link as equal", () => {
    const base = "Ship the new feature today and tell your friends about it";
    expect(normalizeContent(base)).toBe(normalizeContent(`${base} https://x.co/abc`));
  });

  it("emoji-only / whitespace-only content normalises to the empty string", () => {
    expect(normalizeContent("   ")).toBe("");
    expect(normalizeContent("🚀🚀🚀")).toBe("");
  });
});

describe("hashContent", () => {
  it("is identical for inputs that normalise to the same thing", () => {
    expect(hashContent("Hello   World!!")).toBe(hashContent("hello world"));
  });

  it("differs for genuinely different content", () => {
    expect(hashContent("hello world")).not.toBe(hashContent("goodbye world"));
  });

  it("returns the empty string for empty / whitespace / emoji-only input (never hashes nothing)", () => {
    expect(hashContent("")).toBe("");
    expect(hashContent("   ")).toBe("");
    expect(hashContent("🚀")).toBe("");
  });

  it("produces a 64-char sha256 hex digest for real content", () => {
    expect(hashContent("a real post")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("contentTrigrams / jaccard", () => {
  it("builds a sliding 3-word window; a 6-word post yields 4 trigrams", () => {
    const grams = contentTrigrams("five proven tips grow audience fast");
    expect(grams.size).toBe(4);
    expect(grams.has("five␟proven␟tips")).toBe(true);
    expect(grams.has("grow␟audience␟fast")).toBe(true);
  });

  it("returns an empty set for fewer than 3 words", () => {
    expect(contentTrigrams("two words").size).toBe(0);
    expect(contentTrigrams("").size).toBe(0);
  });

  it("scores two empty sets as 0 (absence of signal, not a perfect match)", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("computes |∩| / |∪| for overlapping sets", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z", "w"]);
    // intersection {y,z}=2, union {x,y,z,w}=4 → 0.5
    expect(jaccard(a, b)).toBe(0.5);
  });
});

describe("similarity", () => {
  it("scores identical posts as 1", () => {
    expect(similarity("the quick brown fox jumps", "the quick brown fox jumps")).toBe(1);
  });

  it("scores a single-word swap on a long post at or above the near-dup threshold", () => {
    const a = "here are five proven tips to grow your audience on social media this year fast";
    const b = "here are five proven tips to grow your audience on social platforms this year fast";
    const score = similarity(a, b);
    expect(score).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
  });

  it("scores two distinct posts on the same theme well below the threshold", () => {
    const a = "budgeting tips for new founders who want to save money every single month";
    const b = "how to hire your first employee without blowing your entire startup runway";
    expect(similarity(a, b)).toBeLessThan(NEAR_DUP_THRESHOLD);
  });

  it("falls back to exact equality for posts shorter than 3 words", () => {
    // Same after normalisation → 1.
    expect(similarity("Big Sale!", "big sale")).toBe(1);
    // Different short text can never be a fuzzy near-match → 0.
    expect(similarity("Big Sale", "Huge Sale")).toBe(0);
  });

  it("scores empty-normalising content as 0, never as a dup of anything", () => {
    // A bare link vs emoji-only: both normalise to "" but carry no comparable
    // signal — they must NOT collide as a perfect match (would be 1 if the
    // na === nb short-circuit ran before the empty guard).
    expect(similarity("https://a.com/x", "🔥🔥🔥")).toBe(0);
    // Two different hashtag-only posts also normalise to "" — still 0, not 1.
    expect(similarity("#growth #saas", "#hiring #news")).toBe(0);
    // Empty vs real content is likewise never a dup.
    expect(similarity("🚀🚀🚀", "here are five proven tips to grow")).toBe(0);
  });

  it("classifies a constructed boundary pair (Jaccard == 0.6) as a near-dup", () => {
    // 6-word posts share their first 5 words → 3 of 4 trigrams overlap.
    // intersection=3, union=5 → exactly 0.6, which is >= NEAR_DUP_THRESHOLD.
    const a = "five proven tips grow audience fast";
    const b = "five proven tips grow audience now";
    const score = similarity(a, b);
    expect(score).toBeCloseTo(0.6, 10);
    expect(score).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
  });
});

// ── isNearDuplicate — the gate-facing, length-aware near classifier ──────────
//
// The dedup gate calls isNearDuplicate (not a bare similarity >= threshold) so
// its near-detection inherits the length-aware rule: short posts must clear the
// Jaccard threshold AND share enough ABSOLUTE trigrams that a single coincidental
// run can't flag them; long posts keep the pure 0.6 rule.

describe("isNearDuplicate", () => {
  it("does NOT flag two short posts that share only a single 5-word run", () => {
    // 6-word posts sharing their 5-word prefix: Jaccard is exactly 0.6 but the 3
    // shared trigrams all come from ONE coincidental phrase — not a reword.
    expect(
      isNearDuplicate("here is the secret to growth", "here is the secret to failure"),
    ).toBe(false);
  });

  it("flags a genuine short near-dup (overlap beyond a single run)", () => {
    // 9-word posts differing only in the last word: 5 shared trigrams, Jaccard
    // 0.75 — clearly the same short post reworded, so near despite being short.
    const a = "grow your audience on social media this entire year";
    const b = "grow your audience on social media this entire decade";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("flags genuinely near long paraphrases (pure threshold rule applies)", () => {
    // >= 12 words on both sides: the Jaccard ratio alone is trustworthy.
    const a =
      "here are five proven tips to grow your audience on social media this year fast";
    const b =
      "here are five proven tips to grow your audience on social platforms this year fast";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("never flags empty-normalising or genuinely distinct content", () => {
    // Empty-normalising sides score 0 → never near.
    expect(isNearDuplicate("https://a.com/x", "🔥🔥🔥")).toBe(false);
    expect(isNearDuplicate("#growth #saas", "#hiring #news")).toBe(false);
    // Distinct same-theme long posts stay below threshold → not near.
    const a = "budgeting tips for new founders who want to save money every single month";
    const b = "how to hire your first employee without blowing your entire startup runway";
    expect(isNearDuplicate(a, b)).toBe(false);
  });
});

describe("precompiled helpers match their raw counterparts exactly", () => {
  // The gate's perf path swaps similarity()/isNearDuplicate() for the compiled
  // variants. They MUST agree bit-for-bit on every input class, or dedup verdicts
  // would silently drift. Cover: identical, link-only-diff, paraphrase, distinct,
  // short pairs (the length-aware branch), empty-normalising, and self-pairs.
  const SAMPLES = [
    "Big news today: we just shipped dark mode. Try it now!",
    "Big news today: we just shipped dark mode. Try it now! https://mm.co/x",
    "Here is the one budgeting tip that completely changed how I run my small business every single month",
    "Here is the one budgeting tip that completely changed how I run my small business every month",
    "Five hiring mistakes that quietly killed our first startup team",
    "Sale!",
    "Sale",
    "here is the secret to growth",
    "here is the secret to failure",
    "🚀🚀🚀",
    "#growth @bob https://example.com",
    "",
    "a b",
    "one two three four five",
  ];

  it("similarityCompiled === similarity and isNearDuplicateCompiled === isNearDuplicate for all pairs", () => {
    for (const a of SAMPLES) {
      const ca = compileText(a);
      for (const b of SAMPLES) {
        const cb = compileText(b);
        expect(similarityCompiled(ca, cb)).toBe(similarity(a, b));
        expect(isNearDuplicateCompiled(ca, cb)).toBe(isNearDuplicate(a, b));
      }
    }
  });
});

import { describe, it, expect } from "vitest";
import { scorePost } from "@/lib/feedback/post-performance";

// ── Unit: scorePost — PURE per-post verdict + score (T1.2). ──────────────────
//
// scorePost takes one post's latest metric snapshot + the workspace engagement
// corpus (rate + posted_at, for decay weighting) and returns a verdict/score.
// Everything here is offline and clock-injected via the `now` arg.
//
// Covers the contract's bands:
//   ratio 2.0 -> winner, score 100
//   ratio 1.2 -> strong
//   ratio 0.4 -> underperformer
//   ratio 1.0 -> average
//   <48h or null engagement -> pending
//   decay-weighted baseline shifts when identical rates are dated differently
//   saves top-decile -> +10 (capped at 100); saves null -> no change
//   percentile rises monotonically with rate

const NOW = new Date("2026-06-17T00:00:00Z");

// A post old enough to be judged (well past the 48h age gate).
function settled(date = "2026-06-01T00:00:00Z") {
  return date;
}

// A flat corpus of `n` identical-rate posts, all posted on `date` (so decay
// weighting is uniform). Baseline (weighted median) == `rate`.
function flatCorpus(rate: number, n: number, date = "2026-06-10T00:00:00Z") {
  return Array.from({ length: n }, () => ({ engagement_rate: rate, posted_at: date }));
}

describe("scorePost — verdict bands", () => {
  it("ratio 2.0 -> winner with score 100", () => {
    const corpus = flatCorpus(0.05, 8); // baseline 0.05
    const r = scorePost(
      { engagement_rate: 0.1, saves: null, posted_at: settled() }, // 0.1/0.05 = 2.0
      corpus,
      NOW,
    );
    expect(r.baseline).toBeCloseTo(0.05, 6);
    expect(r.ratio).toBeCloseTo(2.0, 6);
    expect(r.verdict).toBe("winner");
    expect(r.score).toBe(100);
  });

  it("ratio 1.2 -> strong", () => {
    const corpus = flatCorpus(0.05, 8);
    const r = scorePost(
      { engagement_rate: 0.06, saves: null, posted_at: settled() }, // 1.2
      corpus,
      NOW,
    );
    expect(r.ratio).toBeCloseTo(1.2, 6);
    expect(r.verdict).toBe("strong");
    expect(r.score).toBe(60); // round(50 * 1.2)
  });

  it("ratio 0.4 -> underperformer", () => {
    const corpus = flatCorpus(0.05, 8);
    const r = scorePost(
      { engagement_rate: 0.02, saves: null, posted_at: settled() }, // 0.4
      corpus,
      NOW,
    );
    expect(r.ratio).toBeCloseTo(0.4, 6);
    expect(r.verdict).toBe("underperformer");
    expect(r.score).toBe(20); // round(50 * 0.4)
  });

  it("ratio 1.0 -> average", () => {
    const corpus = flatCorpus(0.05, 8);
    const r = scorePost(
      { engagement_rate: 0.05, saves: null, posted_at: settled() }, // 1.0
      corpus,
      NOW,
    );
    expect(r.ratio).toBeCloseTo(1.0, 6);
    expect(r.verdict).toBe("average");
    expect(r.score).toBe(50);
  });
});

describe("scorePost — pending gate", () => {
  it("a post younger than 48h is pending (no ratio/score)", () => {
    const corpus = flatCorpus(0.05, 8);
    const fresh = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString(); // 10h ago
    const r = scorePost(
      { engagement_rate: 0.2, saves: 5, posted_at: fresh },
      corpus,
      NOW,
    );
    expect(r.verdict).toBe("pending");
    expect(r.ratio).toBeNull();
    expect(r.score).toBeNull();
  });

  it("null engagement_rate is pending even when old", () => {
    const corpus = flatCorpus(0.05, 8);
    const r = scorePost(
      { engagement_rate: null, saves: null, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(r.verdict).toBe("pending");
    expect(r.ratio).toBeNull();
    expect(r.score).toBeNull();
    // No rate -> percentile is also null.
    expect(r.percentile).toBeNull();
  });
});

describe("scorePost — decay-weighted baseline", () => {
  it("shifts when identical rates are dated differently", () => {
    // Corpus of three rates: one LOW (0.02) + two HIGH (0.10). With all three
    // FRESH (equal weight) the 50%-cumulative-weight crossing lands on a HIGH
    // post, so the weighted median is 0.10. Age BOTH high posts ~150 days back
    // (5 half-lives -> ~3% weight) and the fresh LOW post now carries the
    // crossing, dropping the median to 0.02. Same three rates — only the DATES
    // changed — so the baseline moves purely from decay weighting.
    const freshLow = { engagement_rate: 0.02, posted_at: "2026-06-16T00:00:00Z" };

    const allFresh = scorePost(
      { engagement_rate: 0.05, saves: null, posted_at: settled() },
      [
        freshLow,
        { engagement_rate: 0.1, posted_at: "2026-06-16T00:00:00Z" },
        { engagement_rate: 0.1, posted_at: "2026-06-16T00:00:00Z" },
      ],
      NOW,
    );

    const highsStale = scorePost(
      { engagement_rate: 0.05, saves: null, posted_at: settled() },
      [
        freshLow,
        { engagement_rate: 0.1, posted_at: "2026-01-18T00:00:00Z" },
        { engagement_rate: 0.1, posted_at: "2026-01-18T00:00:00Z" },
      ],
      NOW,
    );

    // Baseline is strictly lower once the high posts decay away.
    expect(highsStale.baseline).toBeLessThan(allFresh.baseline);
    expect(allFresh.baseline).toBeCloseTo(0.1, 6);
    expect(highsStale.baseline).toBeCloseTo(0.02, 6);
  });
});

describe("scorePost — saves bonus", () => {
  it("top-decile saves add +10 (still below the cap)", () => {
    const corpus = flatCorpus(0.05, 10); // baseline 0.05
    // Rate 0.055 -> ratio 1.1 -> strong, base score round(55) = 55. The post
    // beats 100% of the (lower-rate) corpus -> top decile -> +10 = 65.
    const withSaves = scorePost(
      { engagement_rate: 0.055, saves: 42, posted_at: settled() },
      corpus,
      NOW,
    );
    const withoutBonus = scorePost(
      { engagement_rate: 0.055, saves: null, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(withoutBonus.score).toBe(55);
    expect(withSaves.score).toBe(65);
  });

  it("the +10 bonus is capped at 100", () => {
    const corpus = flatCorpus(0.05, 10); // baseline 0.05
    // Rate 0.15 -> ratio 3 -> base score clamps to 100; top-decile saves try
    // to add +10 but the cap holds at 100.
    const r = scorePost(
      { engagement_rate: 0.15, saves: 99, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(r.verdict).toBe("winner");
    expect(r.score).toBe(100);
  });

  it("saves null leaves the score unchanged", () => {
    const corpus = flatCorpus(0.05, 10);
    const base = scorePost(
      { engagement_rate: 0.055, saves: null, posted_at: settled() },
      corpus,
      NOW,
    );
    const same = scorePost(
      { engagement_rate: 0.055, saves: null, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(base.score).toBe(same.score);
    expect(base.score).toBe(55);
  });

  it("saves present but the post is NOT top-decile -> no bonus", () => {
    // Baseline 0.05, the post sits AT baseline (ratio 1.0). Its percentile is
    // not top-decile, so even with saves there's no bonus.
    const corpus = flatCorpus(0.05, 10);
    const r = scorePost(
      { engagement_rate: 0.05, saves: 7, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(r.score).toBe(50); // unchanged 50, no +10
  });
});

describe("scorePost — saves self-exclusion (corpus-member path)", () => {
  it("fires the +10 saves bonus for a genuine top performer that IS in the corpus", () => {
    // Mirror loadWorkspacePerformance: the scored post is itself a member of
    // `corpus`. Eight average posts (0.05) + this one top post (0.10). Without
    // self-exclusion the post's own weight inflates the percentile denominator
    // so it can never reach p90 (weightedPercentile counts STRICTLY below) and
    // the bonus never fires.
    const top = { engagement_rate: 0.1, posted_at: "2026-06-10T00:00:00Z" };
    const corpus = [...flatCorpus(0.05, 8), top]; // post is a corpus member

    const withExclude = scorePost(
      { engagement_rate: 0.1, saves: 42, posted_at: settled() },
      corpus,
      NOW,
      { excludeSelf: true },
    );
    // Drop self weight -> the post beats 100% of the remaining 8 posts -> p90 ->
    // +10. Ratio 0.1/0.05 = 2.0 -> base score clamps to 100, then capped at 100.
    expect(withExclude.verdict).toBe("winner");
    expect(withExclude.score).toBe(100);

    // A strong-but-not-saturated case so the +10 is visible (not pre-clamped).
    const topStrong = { engagement_rate: 0.055, posted_at: "2026-06-10T00:00:00Z" };
    const corpusStrong = [...flatCorpus(0.05, 8), topStrong];
    const strongWithExclude = scorePost(
      { engagement_rate: 0.055, saves: 42, posted_at: settled() },
      corpusStrong,
      NOW,
      { excludeSelf: true },
    );
    const strongNoExclude = scorePost(
      { engagement_rate: 0.055, saves: 42, posted_at: settled() },
      corpusStrong,
      NOW,
      // Without excludeSelf the self weight stays in the denominator: 8 of 9
      // posts are strictly below -> ~88.9% < 90 -> no bonus.
    );
    expect(strongNoExclude.score).toBe(55); // base round(50 * 1.1), no bonus
    expect(strongWithExclude.score).toBe(65); // self-excluded -> p90 -> +10
  });
});

describe("scorePost — min-sample guard", () => {
  it("a corpus under 4 effective points yields 'pending' (no winner/underperformer)", () => {
    // Three posts in the corpus (+ the scored post is one of them, but the
    // corpus itself only has 3 weight-bearing points). Even a 2.0-ratio post
    // must NOT be called a winner — there isn't enough signal.
    const corpus = flatCorpus(0.05, 3);
    const r = scorePost(
      { engagement_rate: 0.1, saves: 99, posted_at: settled() }, // would be ratio 2.0
      corpus,
      NOW,
    );
    expect(r.verdict).toBe("pending");
    expect(r.score).toBeNull();
    expect(r.ratio).toBeNull();
  });

  it("at exactly 4 effective points a confident verdict is allowed again", () => {
    const corpus = flatCorpus(0.05, 4);
    const r = scorePost(
      { engagement_rate: 0.1, saves: null, posted_at: settled() }, // ratio 2.0
      corpus,
      NOW,
    );
    expect(r.verdict).toBe("winner");
    expect(r.ratio).toBeCloseTo(2.0, 6);
  });
});

describe("scorePost — weighted-median interpolation", () => {
  it("interpolates the baseline on an even, equal-weight corpus", () => {
    // Equal-weight rates 0.04 & 0.08: cumulative weight lands EXACTLY on half
    // after the first element, so the median is the boundary -> (0.04+0.08)/2 =
    // 0.06, not the lower 0.04. Pad to >=4 effective points so the min-sample
    // guard doesn't fire (two copies of each, all same date = equal weight).
    const date = "2026-06-10T00:00:00Z";
    const corpus = [
      { engagement_rate: 0.04, posted_at: date },
      { engagement_rate: 0.04, posted_at: date },
      { engagement_rate: 0.08, posted_at: date },
      { engagement_rate: 0.08, posted_at: date },
    ];
    const r = scorePost(
      { engagement_rate: 0.06, saves: null, posted_at: settled() },
      corpus,
      NOW,
    );
    expect(r.baseline).toBeCloseTo(0.06, 6);
  });
});

describe("scorePost — percentile monotonicity", () => {
  it("percentile rises monotonically with the post's rate", () => {
    // A spread corpus, all same date (uniform decay weight).
    const corpus = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08].map((rate) => ({
      engagement_rate: rate,
      posted_at: "2026-06-10T00:00:00Z",
    }));
    const rates = [0.0, 0.025, 0.045, 0.065, 0.09];
    const pcts = rates.map(
      (rate) =>
        scorePost({ engagement_rate: rate, saves: null, posted_at: settled() }, corpus, NOW)
          .percentile as number,
    );
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]!);
    }
    // Sanity bounds: nothing below the lowest, everything above the highest.
    expect(pcts[0]).toBe(0); // rate 0 beats none
    expect(pcts[pcts.length - 1]).toBe(100); // rate above all beats all
  });
});

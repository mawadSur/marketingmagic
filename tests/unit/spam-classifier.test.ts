import { describe, expect, it } from "vitest";
import {
  classifySpamHeuristic,
  verdictForScore,
  SPAM_THRESHOLD,
  HAM_CEILING,
  W_SINGLE_LINK,
  W_KNOWN_PATTERN,
} from "@/lib/interactions/spam";
import {
  evaluateSpamIgnoreGate,
  type SpamIgnoreGateInput,
} from "@/lib/interactions/auto-reply/spam-policy";

// ── TODO #0 (gap 1) — the SPAM CLASSIFIER + the SPAM-IGNORE GATE ─────────────
//
// Auto-ignoring a row HIDES it from the operator. A false positive drops a real
// customer reply. So the load-bearing assertions here are:
//   * clear spam is flagged 'spam' (>= SPAM_THRESHOLD),
//   * clear ham passes (verdict 'ham', never auto-ignored),
//   * borderline lands in the grey band → review, NOT auto-ignore,
//   * the gate is fail-closed: any ambiguous condition resolves to "do not
//     ignore", and only a confident 'spam' verdict on a trusted+engaged
//     account ever flips a row.

describe("classifySpamHeuristic — clear spam is flagged", () => {
  it("flags a crypto-giveaway scam with an off-platform link", () => {
    const c = classifySpamHeuristic(
      "🚀🚀 FREE CRYPTO airdrop!! double your money guaranteed — DM me to claim https://scam.io https://t.me/scamchannel",
    );
    expect(c.verdict).toBe("spam");
    expect(c.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
    // The known-pattern signal must have fired.
    expect(c.signals.some((s) => s.key === "known_pattern")).toBe(true);
  });

  it("flags follower/SEO-selling spam with mention stuffing", () => {
    const c = classifySpamHeuristic(
      "cheap followers for sale! @a @b @c @d @e get backlinks services cheap https://buyfollows.example",
    );
    expect(c.verdict).toBe("spam");
    expect(c.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
  });

  it("flags repeated gibberish promo with multiple links", () => {
    // multiple_links (2 URLs) + unnatural repetition + gibberish stack past
    // the threshold — no single signal would, which is the design.
    const c = classifySpamHeuristic(
      "win win win win win win!!!!!!!! 999 000 ### @@@ %%% https://a.io/x99 https://b.io/y00",
    );
    expect(c.verdict).toBe("spam");
    expect(c.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
  });
});

describe("classifySpamHeuristic — clear ham passes", () => {
  it("passes a genuine product question", () => {
    const c = classifySpamHeuristic(
      "Hey, love the tool! Quick question — does the scheduler support time zones per channel?",
    );
    expect(c.verdict).toBe("ham");
    expect(c.score).toBeLessThanOrEqual(HAM_CEILING);
  });

  it("passes genuine criticism without spam signals", () => {
    const c = classifySpamHeuristic(
      "Honestly the onboarding confused me. I couldn't find where to connect LinkedIn.",
    );
    expect(c.verdict).toBe("ham");
  });

  it("a single legit link from a customer is NOT spam on its own", () => {
    const c = classifySpamHeuristic(
      "Here's the repo I mentioned, would love your take: https://github.com/me/project",
    );
    // One link alone is well under the threshold — never auto-ignored.
    expect(c.verdict).not.toBe("spam");
    expect(c.score).toBe(W_SINGLE_LINK);
  });

  it("empty / whitespace body scores 0 (ham) — never auto-ignored", () => {
    expect(classifySpamHeuristic("").verdict).toBe("ham");
    expect(classifySpamHeuristic("   ").score).toBe(0);
  });

  it("a short all-caps acronym is not treated as shouting", () => {
    const c = classifySpamHeuristic("LOL nice");
    expect(c.verdict).toBe("ham");
  });
});

describe("classifySpamHeuristic — borderline goes to review, not auto-ignore", () => {
  it("a single soft signal lands in the grey band", () => {
    // One known pattern (40) alone is below SPAM_THRESHOLD (70) → borderline.
    const c = classifySpamHeuristic("dm me for the details");
    expect(c.score).toBe(W_KNOWN_PATTERN);
    expect(c.verdict).toBe("borderline");
    expect(c.verdict).not.toBe("spam"); // crucial: NOT auto-ignored on heuristics
  });

  it("verdictForScore respects the band boundaries", () => {
    expect(verdictForScore(SPAM_THRESHOLD)).toBe("spam");
    expect(verdictForScore(SPAM_THRESHOLD - 1)).toBe("borderline");
    expect(verdictForScore(HAM_CEILING)).toBe("ham");
    expect(verdictForScore(HAM_CEILING + 1)).toBe("borderline");
    expect(verdictForScore(0)).toBe("ham");
    expect(verdictForScore(100)).toBe("spam");
  });
});

describe("evaluateSpamIgnoreGate — fail-closed, conservative", () => {
  const ok: SpamIgnoreGateInput = {
    channel: "x",
    trustMode: true,
    spamIgnoreEnabled: true,
    isLive: true,
    killSwitch: false,
    interactionStatus: "unread",
    isSpam: true,
  };

  it("allows ignore when everything lines up (trusted + engaged + spam + unread)", () => {
    expect(evaluateSpamIgnoreGate(ok)).toEqual({ ignore: true, reason: null });
  });

  it("kill switch wins over everything", () => {
    expect(evaluateSpamIgnoreGate({ ...ok, killSwitch: true })).toEqual({
      ignore: false,
      reason: "kill_switch",
    });
  });

  it("never auto-ignores a non-spam verdict", () => {
    expect(evaluateSpamIgnoreGate({ ...ok, isSpam: false })).toEqual({
      ignore: false,
      reason: "not_spam",
    });
  });

  it("never auto-ignores an unsupported channel", () => {
    expect(evaluateSpamIgnoreGate({ ...ok, channel: "instagram" }).reason).toBe(
      "channel_unsupported",
    );
  });

  it("requires the feature to be engaged (off → not_opted_in)", () => {
    expect(
      evaluateSpamIgnoreGate({ ...ok, spamIgnoreEnabled: false }).reason,
    ).toBe("not_opted_in");
  });

  it("requires trust ONLY for live; shadow may preview without it", () => {
    // Live without trust → blocked.
    expect(
      evaluateSpamIgnoreGate({ ...ok, trustMode: false, isLive: true }).reason,
    ).toBe("not_trusted");
    // Shadow without trust → allowed (preview before trust; zero blast radius).
    expect(
      evaluateSpamIgnoreGate({ ...ok, trustMode: false, isLive: false }),
    ).toEqual({ ignore: true, reason: null });
  });

  it("only acts on fresh unread rows", () => {
    expect(
      evaluateSpamIgnoreGate({ ...ok, interactionStatus: "replied" }).reason,
    ).toBe("already_actioned");
  });
});

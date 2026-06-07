import { describe, expect, it } from "vitest";
import {
  evaluateAutoReplyGate,
  checkRateCap,
  countWithinWindow,
  isAutoReplyChannel,
  AUTO_REPLY_RATE_CAP_PER_HOUR,
  RATE_CAP_WINDOW_MS,
  type AutoReplyGateInput,
} from "@/lib/interactions/auto-reply/policy";
import { matchLeadKeyword } from "@/lib/interactions/auto-reply/lead-capture";

// ── Bet 4 — autonomous auto-reply GATE + RATE CAP ──────────────────────────
//
// This is the safety core of the whole feature: it decides whether a public
// reply gets sent at a named person with no human in the loop. Default-OFF and
// fail-closed are the load-bearing invariants, so we exercise every branch.

// A fully "green" gate input — every condition satisfied. Each test flips one
// field to prove that single condition is decisive.
const green: AutoReplyGateInput = {
  channel: "x",
  trustMode: true,
  autoReplyEnabled: true,
  killSwitch: false,
  interactionStatus: "unread",
  hasDraft: true,
};

describe("evaluateAutoReplyGate — happy path", () => {
  it("sends when every condition is satisfied", () => {
    const d = evaluateAutoReplyGate(green);
    expect(d.send).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("sends on each shippable channel", () => {
    for (const channel of ["x", "bluesky", "linkedin"] as const) {
      expect(evaluateAutoReplyGate({ ...green, channel }).send).toBe(true);
    }
  });
});

describe("evaluateAutoReplyGate — fail-closed, priority order", () => {
  it("kill switch overrides everything (even an otherwise-green input)", () => {
    const d = evaluateAutoReplyGate({ ...green, killSwitch: true });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("kill_switch");
  });

  it("kill switch wins even when trust + opt-in are also off", () => {
    const d = evaluateAutoReplyGate({
      ...green,
      killSwitch: true,
      trustMode: false,
      autoReplyEnabled: false,
    });
    expect(d.reason).toBe("kill_switch");
  });

  it("blocks IG / Threads (Meta App Review excluded channels)", () => {
    for (const channel of ["instagram", "threads", "facebook", "tiktok"]) {
      const d = evaluateAutoReplyGate({ ...green, channel });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("channel_unsupported");
    }
  });

  it("blocks when the existing trust model (trust_mode) is off", () => {
    const d = evaluateAutoReplyGate({ ...green, trustMode: false });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("not_trusted");
  });

  it("blocks when trust is on but the auto-reply opt-in is off (default)", () => {
    const d = evaluateAutoReplyGate({ ...green, autoReplyEnabled: false });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("not_opted_in");
  });

  it("blocks anything not freshly unread (already replied/read/snoozed)", () => {
    for (const status of ["read", "replied", "snoozed", "dismissed"]) {
      const d = evaluateAutoReplyGate({ ...green, interactionStatus: status });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("already_replied");
    }
  });

  it("blocks when there is no draft to send", () => {
    const d = evaluateAutoReplyGate({ ...green, hasDraft: false });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("empty_draft");
  });

  it("DEFAULTS ARE OFF: a never-configured account never sends", () => {
    // Mirrors the DB defaults: trust_mode=false, auto_reply_enabled=false,
    // kill switch defaults false (= not killed). The opt-ins being off is
    // what holds the line.
    const d = evaluateAutoReplyGate({
      channel: "x",
      trustMode: false,
      autoReplyEnabled: false,
      killSwitch: false,
      interactionStatus: "unread",
      hasDraft: true,
    });
    expect(d.send).toBe(false);
    // trust_mode is checked before the opt-in, so this surfaces not_trusted.
    expect(d.reason).toBe("not_trusted");
  });
});

describe("isAutoReplyChannel", () => {
  it("accepts exactly x / bluesky / linkedin", () => {
    expect(isAutoReplyChannel("x")).toBe(true);
    expect(isAutoReplyChannel("bluesky")).toBe(true);
    expect(isAutoReplyChannel("linkedin")).toBe(true);
  });
  it("rejects IG / Threads / others", () => {
    expect(isAutoReplyChannel("instagram")).toBe(false);
    expect(isAutoReplyChannel("threads")).toBe(false);
    expect(isAutoReplyChannel("facebook")).toBe(false);
    expect(isAutoReplyChannel("")).toBe(false);
  });
});

// ── Rate cap ────────────────────────────────────────────────────────────────

describe("countWithinWindow", () => {
  const now = 10_000_000;
  it("counts only timestamps inside the trailing window", () => {
    const oneHour = RATE_CAP_WINDOW_MS;
    const ts = [
      now - 1000, // in
      now - oneHour + 1, // in (just inside)
      now - oneHour - 1, // out (just outside)
      now - 5 * oneHour, // out
    ];
    expect(countWithinWindow(ts, now, oneHour)).toBe(2);
  });
  it("treats the window boundary as exclusive on the old side", () => {
    const oneHour = RATE_CAP_WINDOW_MS;
    expect(countWithinWindow([now - oneHour], now, oneHour)).toBe(0);
    expect(countWithinWindow([now - oneHour + 1], now, oneHour)).toBe(1);
  });
  it("ignores non-finite timestamps", () => {
    expect(countWithinWindow([NaN, Infinity, now - 1], now)).toBe(1);
  });
  it("empty history → 0", () => {
    expect(countWithinWindow([], now)).toBe(0);
  });
});

describe("checkRateCap", () => {
  const now = 10_000_000;

  it("allows when under the per-channel cap", () => {
    const cap = AUTO_REPLY_RATE_CAP_PER_HOUR.x;
    const sent = Array.from({ length: cap - 1 }, () => now - 60_000);
    const d = checkRateCap("x", sent, now);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(cap - 1);
    expect(d.remaining).toBe(1);
  });

  it("blocks exactly AT the cap (cap is a hard ceiling, not a soft one)", () => {
    const cap = AUTO_REPLY_RATE_CAP_PER_HOUR.linkedin;
    const sent = Array.from({ length: cap }, () => now - 60_000);
    const d = checkRateCap("linkedin", sent, now);
    expect(d.allowed).toBe(false);
    expect(d.used).toBe(cap);
    expect(d.remaining).toBe(0);
  });

  it("blocks when over the cap", () => {
    const cap = AUTO_REPLY_RATE_CAP_PER_HOUR.bluesky;
    const sent = Array.from({ length: cap + 3 }, () => now - 60_000);
    const d = checkRateCap("bluesky", sent, now);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
  });

  it("only counts sends inside the trailing hour — old sends free up budget", () => {
    const cap = AUTO_REPLY_RATE_CAP_PER_HOUR.x;
    // cap sends, but all OUTSIDE the window → none count → allowed again.
    const old = Array.from({ length: cap + 5 }, () => now - 2 * RATE_CAP_WINDOW_MS);
    const d = checkRateCap("x", old, now);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(0);
  });

  it("each channel uses its own cap (linkedin is strictest)", () => {
    expect(AUTO_REPLY_RATE_CAP_PER_HOUR.linkedin).toBeLessThanOrEqual(
      AUTO_REPLY_RATE_CAP_PER_HOUR.x,
    );
    expect(AUTO_REPLY_RATE_CAP_PER_HOUR.x).toBeLessThanOrEqual(
      AUTO_REPLY_RATE_CAP_PER_HOUR.bluesky,
    );
  });
});

// ── Lead-keyword matcher (the testable half of the stubbed lead capture) ─────

describe("matchLeadKeyword", () => {
  const rule = { keywords: ["pricing", "demo", "how much"], link: "https://x.y" };
  it("matches a keyword case-insensitively", () => {
    expect(matchLeadKeyword("What's your PRICING?", rule)).toBe("pricing");
    expect(matchLeadKeyword("can I get a Demo", rule)).toBe("demo");
  });
  it("matches multi-word phrases as substrings", () => {
    expect(matchLeadKeyword("so how much does it cost", rule)).toBe("how much");
  });
  it("returns null on no match", () => {
    expect(matchLeadKeyword("love this post", rule)).toBeNull();
  });
  it("returns null on empty body or empty rule", () => {
    expect(matchLeadKeyword("", rule)).toBeNull();
    expect(matchLeadKeyword("pricing", { keywords: [], link: "" })).toBeNull();
  });
  it("ignores too-short keywords (avoids spurious single-char hits)", () => {
    expect(matchLeadKeyword("a", { keywords: ["a"], link: "" })).toBeNull();
  });
});

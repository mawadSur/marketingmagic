import { describe, expect, it } from "vitest";
import {
  evaluateDmGate,
  checkDmRateCap,
  DM_CAPTURE_RATE_CAP_PER_HOUR,
  AUTO_REPLY_RATE_CAP_PER_HOUR,
  RATE_CAP_WINDOW_MS,
  type DmGateInput,
} from "@/lib/interactions/auto-reply/policy";
import {
  parseLeadKeywordRule,
  buildDmBody,
  matchLeadKeyword,
} from "@/lib/interactions/auto-reply/lead-capture";

// ── Bet 4 — comment→DM lead capture: GATE + RATE CAP + RULE decision ───────
//
// Auto-DMing a stranger is higher blast-radius than the public reply path, so
// these decisions are the safety core: default-OFF, fail-closed, conservative
// caps. Every gate branch + the rule parser + body builder are exercised.

// A fully "green" DM gate input — every condition satisfied. Each test flips
// one field to prove that single condition is decisive, in priority order.
const green: DmGateInput = {
  channel: "x",
  trustMode: true,
  dmCaptureEnabled: true,
  killSwitch: false,
  hasRule: true,
  keywordMatched: true,
  interactionStatus: "unread",
};

describe("evaluateDmGate — happy path", () => {
  it("sends when every condition is satisfied", () => {
    const d = evaluateDmGate(green);
    expect(d.send).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("sends on each shippable channel", () => {
    for (const channel of ["x", "bluesky", "linkedin"] as const) {
      expect(evaluateDmGate({ ...green, channel }).send).toBe(true);
    }
  });
});

describe("evaluateDmGate — fail-closed, priority order", () => {
  it("kill switch overrides everything (shared with the reply path)", () => {
    const d = evaluateDmGate({ ...green, killSwitch: true });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("kill_switch");
  });

  it("kill switch wins even when trust + opt-in are also off", () => {
    const d = evaluateDmGate({
      ...green,
      killSwitch: true,
      trustMode: false,
      dmCaptureEnabled: false,
      hasRule: false,
    });
    expect(d.reason).toBe("kill_switch");
  });

  it("blocks IG / Threads / others (only X/Bluesky/LinkedIn DM)", () => {
    for (const channel of ["instagram", "threads", "facebook", "tiktok", ""]) {
      const d = evaluateDmGate({ ...green, channel });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("channel_unsupported");
    }
  });

  it("blocks when the existing trust model (trust_mode) is off", () => {
    const d = evaluateDmGate({ ...green, trustMode: false });
    expect(d.reason).toBe("not_trusted");
  });

  it("blocks when trust is on but the DM opt-in is off (default)", () => {
    const d = evaluateDmGate({ ...green, dmCaptureEnabled: false });
    expect(d.reason).toBe("not_opted_in");
  });

  it("blocks when no keyword rule is configured", () => {
    const d = evaluateDmGate({ ...green, hasRule: false });
    expect(d.reason).toBe("no_rule");
  });

  it("blocks when a rule exists but nothing matched", () => {
    const d = evaluateDmGate({ ...green, keywordMatched: false });
    expect(d.reason).toBe("no_keyword_match");
  });

  it("blocks anything not freshly unread", () => {
    for (const status of ["read", "replied", "snoozed", "dismissed"]) {
      const d = evaluateDmGate({ ...green, interactionStatus: status });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("already_actioned");
    }
  });

  it("DEFAULTS ARE OFF: a never-configured account never DMs", () => {
    // Mirrors the DB defaults: trust_mode=false, dm_capture_enabled=false,
    // no rule, kill switch false (= not killed). The opt-ins + missing rule
    // hold the line; trust_mode is checked first so we surface not_trusted.
    const d = evaluateDmGate({
      channel: "x",
      trustMode: false,
      dmCaptureEnabled: false,
      killSwitch: false,
      hasRule: false,
      keywordMatched: false,
      interactionStatus: "unread",
    });
    expect(d.send).toBe(false);
    expect(d.reason).toBe("not_trusted");
  });
});

// ── Rate cap (stricter than the reply caps) ─────────────────────────────────

describe("checkDmRateCap", () => {
  const now = 10_000_000;

  it("allows when under the per-channel DM cap", () => {
    const cap = DM_CAPTURE_RATE_CAP_PER_HOUR.bluesky;
    const sent = Array.from({ length: cap - 1 }, () => now - 60_000);
    const d = checkDmRateCap("bluesky", sent, now);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(cap - 1);
    expect(d.remaining).toBe(1);
  });

  it("blocks exactly AT the cap (hard ceiling)", () => {
    const cap = DM_CAPTURE_RATE_CAP_PER_HOUR.x;
    const sent = Array.from({ length: cap }, () => now - 60_000);
    const d = checkDmRateCap("x", sent, now);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
  });

  it("only counts sends inside the trailing hour", () => {
    const cap = DM_CAPTURE_RATE_CAP_PER_HOUR.x;
    const old = Array.from({ length: cap + 5 }, () => now - 2 * RATE_CAP_WINDOW_MS);
    const d = checkDmRateCap("x", old, now);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(0);
  });

  it("DM caps are STRICTLY lower than (or equal to) the reply caps", () => {
    // The whole point: a stray reply is recoverable; a DM burst is a
    // suspension risk. Every channel's DM cap must not exceed its reply cap.
    for (const ch of ["x", "bluesky", "linkedin"] as const) {
      expect(DM_CAPTURE_RATE_CAP_PER_HOUR[ch]).toBeLessThanOrEqual(
        AUTO_REPLY_RATE_CAP_PER_HOUR[ch],
      );
    }
    // LinkedIn is the strictest DM channel.
    expect(DM_CAPTURE_RATE_CAP_PER_HOUR.linkedin).toBeLessThanOrEqual(
      DM_CAPTURE_RATE_CAP_PER_HOUR.x,
    );
  });
});

// ── Rule parsing (fail-closed) ──────────────────────────────────────────────

describe("parseLeadKeywordRule", () => {
  it("parses a well-formed rule", () => {
    const r = parseLeadKeywordRule({
      keywords: ["pricing", "demo"],
      link: "https://book.me/x",
      valueCents: 5000,
      message: "Hey! {{link}}",
    });
    expect(r).not.toBeNull();
    expect(r!.keywords).toEqual(["pricing", "demo"]);
    expect(r!.link).toBe("https://book.me/x");
    expect(r!.valueCents).toBe(5000);
    expect(r!.message).toBe("Hey! {{link}}");
  });

  it("drops too-short / non-string keywords", () => {
    const r = parseLeadKeywordRule({
      keywords: ["a", 42, "demo", "  "],
      link: "https://x.y",
    });
    expect(r!.keywords).toEqual(["demo"]);
  });

  it("returns null when there are no usable keywords", () => {
    expect(parseLeadKeywordRule({ keywords: ["a"], link: "https://x.y" })).toBeNull();
    expect(parseLeadKeywordRule({ keywords: [], link: "https://x.y" })).toBeNull();
  });

  it("returns null when the link is missing/empty (never DM without one)", () => {
    expect(parseLeadKeywordRule({ keywords: ["demo"], link: "" })).toBeNull();
    expect(parseLeadKeywordRule({ keywords: ["demo"] })).toBeNull();
  });

  it("returns null for null / non-object / array input (fail-closed)", () => {
    expect(parseLeadKeywordRule(null)).toBeNull();
    expect(parseLeadKeywordRule(undefined)).toBeNull();
    expect(parseLeadKeywordRule("nope" as unknown as null)).toBeNull();
    expect(parseLeadKeywordRule([1, 2, 3] as unknown as null)).toBeNull();
  });

  it("ignores a negative / non-finite valueCents", () => {
    const r = parseLeadKeywordRule({
      keywords: ["demo"],
      link: "https://x.y",
      valueCents: -1,
    });
    expect(r!.valueCents).toBeUndefined();
  });
});

// ── DM body builder ─────────────────────────────────────────────────────────

describe("buildDmBody", () => {
  const link = "https://book.me/demo";

  it("substitutes {{link}} in a custom template", () => {
    const body = buildDmBody({ keywords: ["demo"], link, message: "Book here: {{link}} 🙌" });
    expect(body).toBe("Book here: https://book.me/demo 🙌");
  });

  it("appends the link when the template omits {{link}}", () => {
    const body = buildDmBody({ keywords: ["demo"], link, message: "Thanks for reaching out!" });
    expect(body).toContain("Thanks for reaching out!");
    expect(body).toContain(link);
  });

  it("uses a neutral default when no message is configured", () => {
    const body = buildDmBody({ keywords: ["demo"], link });
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain(link);
  });

  it("clamps to the 3000-char DM ceiling", () => {
    const body = buildDmBody({ keywords: ["demo"], link, message: "x".repeat(5000) });
    expect(body.length).toBeLessThanOrEqual(3000);
  });
});

// ── The keyword→DM DECISION, end-to-end on pure helpers ─────────────────────
//
// This is the "should we DM, and with what" decision composed from the parser,
// matcher, gate, and body builder exactly as the orchestrator composes them —
// without any network or DB.
describe("keyword→DM decision (composed pure logic)", () => {
  const rawRule = {
    keywords: ["pricing", "demo", "how much"],
    link: "https://book.me/demo",
    valueCents: 2500,
  };

  function decide(body: string, status = "unread", optedIn = true) {
    const rule = parseLeadKeywordRule(rawRule);
    const matched = rule ? matchLeadKeyword(body, rule) : null;
    const gate = evaluateDmGate({
      channel: "x",
      trustMode: true,
      dmCaptureEnabled: optedIn,
      killSwitch: false,
      hasRule: rule !== null,
      keywordMatched: matched !== null,
      interactionStatus: status,
    });
    return { matched, gate, dm: gate.send && rule ? buildDmBody(rule) : null };
  }

  it("fires on a matching comment for an opted-in account", () => {
    const r = decide("hey what's your PRICING like?");
    expect(r.matched).toBe("pricing");
    expect(r.gate.send).toBe(true);
    expect(r.dm).toContain("https://book.me/demo");
  });

  it("holds (no_keyword_match) on a non-matching comment", () => {
    const r = decide("love this, great work!");
    expect(r.matched).toBeNull();
    expect(r.gate.send).toBe(false);
    expect(r.gate.reason).toBe("no_keyword_match");
    expect(r.dm).toBeNull();
  });

  it("holds (not_opted_in) even on a match when the account hasn't opted in", () => {
    const r = decide("can I get a demo", "unread", false);
    expect(r.matched).toBe("demo");
    expect(r.gate.send).toBe(false);
    expect(r.gate.reason).toBe("not_opted_in");
  });
});

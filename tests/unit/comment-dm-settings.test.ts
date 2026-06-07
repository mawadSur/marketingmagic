import { describe, expect, it } from "vitest";
import {
  evaluateDmCaptureEnableGate,
  dmCapabilityHint,
  isAutoReplyChannel,
  type DmCaptureEnableGateInput,
} from "@/lib/interactions/auto-reply/policy";
import {
  parseLeadRuleForm,
  leadRuleToForm,
  splitKeywords,
} from "@/lib/interactions/auto-reply/lead-rule-input";
import { parseLeadKeywordRule } from "@/lib/interactions/auto-reply/lead-capture";

// ── Bet 4 (046) — comment→DM SETTINGS surface: enable-gate + rule validation ──
//
// These back the channel-settings UI that exposes the (already-shipped)
// comment→DM backend. Two safety-critical pieces are unit-tested here:
//   1. evaluateDmCaptureEnableGate — the pure trust-gating logic that
//      setDmCaptureModeAction enforces when flipping dm_capture_enabled ON.
//   2. parseLeadRuleForm — the zod boundary that turns loose form input into a
//      persistable rule, a CLEAR (null), or field errors. Empty → NULL.

// ────────────────────────────────────────────────────────────────────────────
// 1. DM-capture enable gate (mirrors setDmCaptureModeAction's guard)
// ────────────────────────────────────────────────────────────────────────────

// A fully "green" enable input — connected, shippable channel, trust on. Each
// test flips one field to prove that single condition is decisive, in order.
const green: DmCaptureEnableGateInput = {
  channel: "x",
  status: "connected",
  trustMode: true,
};

describe("evaluateDmCaptureEnableGate — happy path", () => {
  it("allows opting in on a connected, trusted, shippable channel", () => {
    const d = evaluateDmCaptureEnableGate(green);
    expect(d.ok).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("allows opt-in on each shippable channel", () => {
    for (const channel of ["x", "bluesky", "linkedin"] as const) {
      expect(evaluateDmCaptureEnableGate({ ...green, channel }).ok).toBe(true);
    }
  });
});

describe("evaluateDmCaptureEnableGate — fail-closed, priority order", () => {
  it("blocks a disconnected account first", () => {
    const d = evaluateDmCaptureEnableGate({ ...green, status: "disconnected" });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("not_connected");
  });

  it("connection check wins even when channel + trust are also bad", () => {
    const d = evaluateDmCaptureEnableGate({
      channel: "instagram",
      status: "disconnected",
      trustMode: false,
    });
    expect(d.reason).toBe("not_connected");
  });

  it("blocks IG / Threads / others (only X/Bluesky/LinkedIn)", () => {
    for (const channel of ["instagram", "threads", "facebook", "tiktok", ""]) {
      const d = evaluateDmCaptureEnableGate({ ...green, channel });
      expect(d.ok).toBe(false);
      expect(d.reason).toBe("channel_unsupported");
    }
  });

  it("requires the EXISTING publishing trust model (trust_mode) to be on", () => {
    const d = evaluateDmCaptureEnableGate({ ...green, trustMode: false });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("not_trusted");
  });

  it("DEFAULTS ARE OFF: a fresh, untrusted account cannot opt in", () => {
    // Mirrors how setTrustModeAction OFF forces dm_capture_enabled OFF, and how
    // the action refuses to flip it on without trust: trust is checked last, so
    // a connected shippable channel with trust off surfaces not_trusted.
    const d = evaluateDmCaptureEnableGate({
      channel: "x",
      status: "connected",
      trustMode: false,
    });
    expect(d.reason).toBe("not_trusted");
  });

  it("the channel set matches the auto-reply channel set (one shippable set)", () => {
    // The enable gate must accept exactly the channels isAutoReplyChannel does.
    for (const channel of ["x", "bluesky", "linkedin"]) {
      expect(isAutoReplyChannel(channel)).toBe(true);
      expect(evaluateDmCaptureEnableGate({ ...green, channel }).ok).toBe(true);
    }
    for (const channel of ["instagram", "threads", "facebook", "tiktok"]) {
      expect(isAutoReplyChannel(channel)).toBe(false);
      expect(evaluateDmCaptureEnableGate({ ...green, channel }).reason).toBe(
        "channel_unsupported",
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Capability hint (honest, static, per-channel)
// ────────────────────────────────────────────────────────────────────────────

describe("dmCapabilityHint", () => {
  it("X needs paid dm.write → not available, honest no-op copy", () => {
    const h = dmCapabilityHint("x");
    expect(h.available).toBe(false);
    expect(h.requirement.toLowerCase()).toContain("dm.write");
    expect(h.note.toLowerCase()).toContain("no-op");
  });

  it("LinkedIn is partnership-gated → not available", () => {
    const h = dmCapabilityHint("linkedin");
    expect(h.available).toBe(false);
    expect(h.requirement.toLowerCase()).toContain("partnership");
  });

  it("Bluesky chat works (recipient opt-in) → available", () => {
    const h = dmCapabilityHint("bluesky");
    expect(h.available).toBe(true);
    expect(h.requirement.toLowerCase()).toContain("chat");
  });

  it("unknown channels get a safe, non-committal hint", () => {
    const h = dmCapabilityHint("instagram");
    expect(h.available).toBe(false);
    expect(h.note.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Lead-rule form validation (zod boundary)
// ────────────────────────────────────────────────────────────────────────────

describe("splitKeywords", () => {
  it("trims, drops <2-char tokens, de-dupes case-insensitively", () => {
    expect(splitKeywords("pricing, demo , a, , DEMO, how much")).toEqual([
      "pricing",
      "demo",
      "how much",
    ]);
  });

  it("returns [] for an all-blank / too-short input", () => {
    expect(splitKeywords("")).toEqual([]);
    expect(splitKeywords(" , a , x ")).toEqual([]);
  });
});

describe("parseLeadRuleForm — CLEAR semantics", () => {
  it("an entirely empty form clears the rule (rule = null → write NULL)", () => {
    const r = parseLeadRuleForm({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule).toBeNull();
  });

  it("a form of only-whitespace fields also clears", () => {
    const r = parseLeadRuleForm({
      keywords: "   ",
      link: "  ",
      message: "",
      valueDollars: " ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule).toBeNull();
  });
});

describe("parseLeadRuleForm — valid rules", () => {
  it("normalises a full form into a persistable rule", () => {
    const r = parseLeadRuleForm({
      keywords: "pricing, demo, how much",
      link: "https://book.example.com/demo",
      message: "Hey! Here's the link: {{link}}",
      valueDollars: "25",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).not.toBeNull();
    expect(r.rule!.keywords).toEqual(["pricing", "demo", "how much"]);
    expect(r.rule!.link).toBe("https://book.example.com/demo");
    expect(r.rule!.message).toBe("Hey! Here's the link: {{link}}");
    expect(r.rule!.valueCents).toBe(2500); // $25 → cents
  });

  it("accepts a minimal rule (keywords + link only)", () => {
    const r = parseLeadRuleForm({
      keywords: "demo",
      link: "https://x.example/y",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule!.valueCents).toBeUndefined();
    expect(r.rule!.message).toBeUndefined();
  });

  it("rounds fractional dollars to cents", () => {
    const r = parseLeadRuleForm({
      keywords: "demo",
      link: "https://x.example/y",
      valueDollars: "25.50",
    });
    expect(r.ok && r.rule!.valueCents).toBe(2550);
  });

  it("treats a $0 value as no value (omitted)", () => {
    const r = parseLeadRuleForm({
      keywords: "demo",
      link: "https://x.example/y",
      valueDollars: "0",
    });
    expect(r.ok && r.rule!.valueCents).toBeUndefined();
  });

  it("anything that validates here re-parses to a usable rule at send time", () => {
    const r = parseLeadRuleForm({
      keywords: "pricing, demo",
      link: "https://book.example.com/demo",
      valueDollars: "10",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Round-trip through the SEND-time parser: the settings-time acceptance bar
    // must never produce a rule that the runtime parser would reject.
    const reparsed = parseLeadKeywordRule(r.rule as never);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.keywords).toEqual(["pricing", "demo"]);
    expect(reparsed!.link).toBe("https://book.example.com/demo");
    expect(reparsed!.valueCents).toBe(1000);
  });
});

describe("parseLeadRuleForm — field errors (never persist a partial rule)", () => {
  it("link without keywords is an error (partial form)", () => {
    const r = parseLeadRuleForm({ link: "https://x.example/y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.keywords).toBeTruthy();
  });

  it("keywords without a link is an error", () => {
    const r = parseLeadRuleForm({ keywords: "demo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.link).toBeTruthy();
  });

  it("rejects a non-http(s) link", () => {
    const r = parseLeadRuleForm({ keywords: "demo", link: "ftp://x/y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.link).toBeTruthy();
  });

  it("rejects a malformed link", () => {
    const r = parseLeadRuleForm({ keywords: "demo", link: "not a url" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.link).toBeTruthy();
  });

  it("rejects a negative / non-numeric value", () => {
    for (const valueDollars of ["-5", "abc"]) {
      const r = parseLeadRuleForm({
        keywords: "demo",
        link: "https://x.example/y",
        valueDollars,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.valueDollars).toBeTruthy();
    }
  });

  it("rejects keywords that are all too short (no usable keyword)", () => {
    const r = parseLeadRuleForm({ keywords: "a, b, c", link: "https://x.example/y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.keywords).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. leadRuleToForm — inverse used to pre-fill the editor
// ────────────────────────────────────────────────────────────────────────────

describe("leadRuleToForm", () => {
  it("renders a null rule as an empty form (the CLEAR state)", () => {
    expect(leadRuleToForm(null)).toEqual({
      keywords: "",
      link: "",
      message: "",
      valueDollars: "",
    });
  });

  it("round-trips a stored rule back to editable strings", () => {
    const form = leadRuleToForm({
      keywords: ["pricing", "demo"],
      link: "https://book.example.com/demo",
      valueCents: 2500,
      message: "Hey {{link}}",
    });
    expect(form.keywords).toBe("pricing, demo");
    expect(form.link).toBe("https://book.example.com/demo");
    expect(form.valueDollars).toBe("25");
    expect(form.message).toBe("Hey {{link}}");

    // And the round-trip re-validates to the same rule.
    const back = parseLeadRuleForm(form);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.rule!.keywords).toEqual(["pricing", "demo"]);
      expect(back.rule!.valueCents).toBe(2500);
    }
  });
});

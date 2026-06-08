import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── TODO #0 (gap 1) — the SPAM-IGNORE ORCHESTRATOR ──────────────────────────
//
// The load-bearing safety assertions:
//   * SHADOW classifies + audits a would-ignore but NEVER flips the row.
//   * LIVE audits + flips status → 'ignored'.
//   * OFF no-ops (no flip, no audit spam) but still persists a spam_score.
//   * Clear ham is KEPT regardless of mode.
//   * The Claude borderline pass is only invoked when opted-in AND borderline.

// Mock the optional Claude classify so no network call happens. The heuristic
// classifier is pure and runs for real.
const classifyBorderlineWithClaudeMock = vi.fn();
vi.mock("@/lib/interactions/spam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/interactions/spam")>();
  return {
    ...actual,
    classifyBorderlineWithClaude: (...a: unknown[]) =>
      classifyBorderlineWithClaudeMock(...a),
  };
});

import { attemptSpamIgnore } from "@/lib/interactions/auto-reply/spam-ignore";
import type { SpamIgnoreContext } from "@/lib/interactions/auto-reply/spam-ignore";

// ── Fake Supabase client ─────────────────────────────────────────────────────
// Records spam_ignore_log inserts and interactions updates.
function fakeSvc() {
  const logInserts: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const svc = {
    from(table: string) {
      if (table === "spam_ignore_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            logInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "interactions") {
        return {
          update: (row: Record<string, unknown>) => {
            interactionUpdates.push(row);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      throw new Error(`fakeSvc: unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { svc, logInserts, interactionUpdates };
}

function account(trust = true) {
  return {
    id: "acct-x",
    workspace_id: "ws-1",
    channel: "x",
    handle: "brand",
    trust_mode: trust,
  } as unknown as Parameters<typeof attemptSpamIgnore>[1];
}

function interaction(body: string, status = "unread") {
  return {
    id: "int-1",
    workspace_id: "ws-1",
    channel: "x",
    external_id: "ext-1",
    parent_post_id: null,
    author_handle: "stranger",
    author_display_name: "Stranger",
    body,
    status,
  } as unknown as Parameters<typeof attemptSpamIgnore>[2];
}

const SPAM_BODY =
  "🚀 FREE CRYPTO airdrop, double your money guaranteed! DM me to claim https://a.io https://t.me/x";
const HAM_BODY = "Hey! Love the product — does it support scheduling across time zones?";
const BORDERLINE_BODY = "dm me for the details"; // one known pattern → borderline

function ctx(
  mode: "off" | "shadow" | "live",
  useClaude = false,
  killSwitch = false,
): SpamIgnoreContext {
  return { mode, useClaude, killSwitch };
}

beforeEach(() => {
  classifyBorderlineWithClaudeMock.mockImplementation(
    async (_body: string, heuristic: unknown) => ({ classification: heuristic, usage: null }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("attemptSpamIgnore — SHADOW", () => {
  it("audits a would-ignore for clear spam but NEVER flips the row", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(svc, account(), interaction(SPAM_BODY), ctx("shadow"));

    expect(res.outcome).toBe("shadow");
    // Exactly one persistScore update + zero flips.
    const flips = interactionUpdates.filter((u) => u.status === "ignored");
    expect(flips.length).toBe(0);
    // Audit row, outcome='shadow', verdict spam.
    expect(logInserts.length).toBe(1);
    expect(logInserts[0].outcome).toBe("shadow");
    expect(logInserts[0].verdict).toBe("spam");
  });

  it("shadow may run WITHOUT trust (preview before trust)", async () => {
    const { svc, logInserts } = fakeSvc();
    const res = await attemptSpamIgnore(
      svc,
      account(false),
      interaction(SPAM_BODY),
      ctx("shadow"),
    );
    expect(res.outcome).toBe("shadow");
    expect(logInserts[0].outcome).toBe("shadow");
  });
});

describe("attemptSpamIgnore — LIVE", () => {
  it("flips clear spam to status='ignored' and audits outcome='ignored'", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(svc, account(), interaction(SPAM_BODY), ctx("live"));

    expect(res.outcome).toBe("ignored");
    const flips = interactionUpdates.filter((u) => u.status === "ignored");
    expect(flips.length).toBe(1);
    expect(logInserts[0].outcome).toBe("ignored");
    expect(logInserts[0].verdict).toBe("spam");
  });

  it("LIVE without trust is HELD (blocked), row NOT flipped", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(
      svc,
      account(false),
      interaction(SPAM_BODY),
      ctx("live"),
    );
    expect(res.outcome).toBe("kept");
    expect(res.reason).toBe("not_trusted");
    const flips = interactionUpdates.filter((u) => u.status === "ignored");
    expect(flips.length).toBe(0);
    // A held clear-spam decision on an engaged account is logged (blocked).
    expect(logInserts.some((l) => l.outcome === "blocked")).toBe(true);
  });

  it("respects the kill switch — clear spam is NOT ignored", async () => {
    const { svc, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(
      svc,
      account(),
      interaction(SPAM_BODY),
      ctx("live", false, true),
    );
    expect(res.outcome).toBe("kept");
    expect(res.reason).toBe("kill_switch");
    expect(interactionUpdates.filter((u) => u.status === "ignored").length).toBe(0);
  });

  it("KEEPS clear ham even in live mode (never auto-ignored)", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(svc, account(), interaction(HAM_BODY), ctx("live"));
    expect(res.outcome).toBe("kept");
    expect(res.reason).toBe("not_spam");
    expect(interactionUpdates.filter((u) => u.status === "ignored").length).toBe(0);
    // Ham is the steady state → no audit spam.
    expect(logInserts.length).toBe(0);
  });
});

describe("attemptSpamIgnore — OFF no-ops but still scores", () => {
  it("does not flip or audit, but DOES persist a spam_score", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(svc, account(), interaction(SPAM_BODY), ctx("off"));
    expect(res.outcome).toBe("kept");
    expect(res.reason).toBe("not_opted_in");
    expect(interactionUpdates.filter((u) => u.status === "ignored").length).toBe(0);
    // No audit spam in 'off'.
    expect(logInserts.length).toBe(0);
    // But the spam_score WAS persisted (powers the inbox spam lane).
    expect(interactionUpdates.some((u) => typeof u.spam_score === "number")).toBe(true);
  });
});

describe("attemptSpamIgnore — Claude borderline escalation", () => {
  it("does NOT call Claude when useClaude is false", async () => {
    const { svc } = fakeSvc();
    await attemptSpamIgnore(svc, account(), interaction(BORDERLINE_BODY), ctx("live", false));
    expect(classifyBorderlineWithClaudeMock).not.toHaveBeenCalled();
  });

  it("calls Claude only on a borderline body when opted in", async () => {
    const { svc } = fakeSvc();
    await attemptSpamIgnore(svc, account(), interaction(BORDERLINE_BODY), ctx("live", true));
    expect(classifyBorderlineWithClaudeMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT call Claude on a clear spam body even when opted in", async () => {
    const { svc } = fakeSvc();
    await attemptSpamIgnore(svc, account(), interaction(SPAM_BODY), ctx("live", true));
    expect(classifyBorderlineWithClaudeMock).not.toHaveBeenCalled();
  });

  it("a confident Claude spam upgrade flips a previously-borderline row", async () => {
    classifyBorderlineWithClaudeMock.mockImplementation(
      async (_body: string, heuristic: { score: number; signals: unknown[] }) => ({
        classification: {
          score: Math.max(heuristic.score, 70),
          verdict: "spam",
          signals: heuristic.signals,
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const { svc, interactionUpdates } = fakeSvc();
    const res = await attemptSpamIgnore(
      svc,
      account(),
      interaction(BORDERLINE_BODY),
      ctx("live", true),
    );
    expect(res.outcome).toBe("ignored");
    expect(interactionUpdates.filter((u) => u.status === "ignored").length).toBe(1);
  });
});

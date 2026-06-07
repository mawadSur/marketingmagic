import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Bet 4 — SHADOW MODE (migration 048): the safety core of the safe state ──
//
// Shadow is a zero-public-blast-radius mode. The WHOLE POINT is that a
// shadow-mode account fully GENERATES what it would send and AUDITS it, but
// NEVER reaches a channel send and NEVER flips the interaction. These tests
// lock that in for BOTH autonomous paths:
//
//   * auto-reply (send.ts)  — mock sendReplyViaChannel, assert NOT called in
//     shadow, called in live; assert outcome='shadow' audit row + no flip;
//     assert shadow is NOT rate-limited; assert 'off' no-ops; assert 'live'
//     still sends + flips.
//   * comment→DM (dm-send.ts) — mock the per-channel DM helpers, assert NO DM
//     helper call in shadow, outcome='shadow' audit row, no lead tag, no flip.
//
// The load-bearing assertion is: in shadow mode the send helper mock is
// NEVER invoked. If that ever regresses, this suite fails loudly.

// ── Mock the drafter so no Claude call happens; it always returns a draft. ──
const draftReplyMock = vi.fn();
vi.mock("@/lib/interactions/draft-reply", () => ({
  draftReply: (...args: unknown[]) => draftReplyMock(...args),
}));

// ── Mock the shared reply SEND core. The CRITICAL safety probe: this must
// NEVER be called in shadow mode. ──
const sendReplyViaChannelMock = vi.fn();
vi.mock("@/lib/interactions/send-core", () => ({
  sendReplyViaChannel: (...args: unknown[]) => sendReplyViaChannelMock(...args),
}));

// ── Mock the per-channel DM helpers. None may be called in shadow mode. ──
const xSendDmMock = vi.fn();
const xResolveUsernameMock = vi.fn();
const loadFreshXCredentialsMock = vi.fn();
const blueskySendDmMock = vi.fn();
const linkedinSendDmMock = vi.fn();
vi.mock("@/lib/social/x", () => ({
  xSendDm: (...a: unknown[]) => xSendDmMock(...a),
  xResolveUsername: (...a: unknown[]) => xResolveUsernameMock(...a),
  loadFreshXCredentials: (...a: unknown[]) => loadFreshXCredentialsMock(...a),
}));
vi.mock("@/lib/social/bluesky", () => ({
  blueskySendDm: (...a: unknown[]) => blueskySendDmMock(...a),
}));
vi.mock("@/lib/social/linkedin", () => ({
  linkedinSendDm: (...a: unknown[]) => linkedinSendDmMock(...a),
}));

import {
  attemptAutoReply,
  type AutoReplyVoiceContext,
} from "@/lib/interactions/auto-reply/send";
import { attemptLeadCaptureDm } from "@/lib/interactions/auto-reply/dm-send";
import {
  parseEngagementMode,
  modeEngages,
  modeSends,
  evaluateAutoReplyGate,
} from "@/lib/interactions/auto-reply/policy";

// ── Fluent fake Supabase client ─────────────────────────────────────────────
// Records auto_reply_log / dm_capture_log inserts and interactions updates, and
// feeds the rate-cap select a configurable set of prior 'sent' rows.
function fakeSvc(sentRows: Array<{ created_at: string }> = []) {
  const logInserts: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const outcomeInserts: Array<Record<string, unknown>> = [];
  const svc = {
    from(table: string) {
      if (table === "auto_reply_log" || table === "dm_capture_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            logInserts.push(row);
            return Promise.resolve({ error: null });
          },
          // rate-cap select chain → resolves to the configured prior sends.
          select: () => ({
            eq: () => ({
              eq: () => ({ gte: () => Promise.resolve({ data: sentRows }) }),
            }),
          }),
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
      if (table === "posts") {
        // loadParentPostText → no parent.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
          }),
        };
      }
      if (table === "post_outcomes") {
        return {
          insert: (row: Record<string, unknown>) => {
            outcomeInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`fakeSvc: unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { svc, logInserts, interactionUpdates, outcomeInserts };
}

const voice: AutoReplyVoiceContext = {
  voiceProfile: null,
  voice: "friendly",
  doNotSay: [],
  productDescription: "a product",
};

// A green, X-channel account — only the mode varies per test.
function account(mode: "off" | "shadow" | "live") {
  return {
    id: "acct-x",
    workspace_id: "ws-1",
    channel: "x",
    handle: "brand",
    credentials: {} as unknown,
    trust_mode: true,
    auto_reply_mode: mode,
    dm_capture_mode: mode,
    // legacy boolean kept in sync (true iff live) — present so we also prove
    // the mode (not the boolean) is what drives behaviour.
    auto_reply_enabled: mode === "live",
    dm_capture_enabled: mode === "live",
    lead_keyword_rule: {
      keywords: ["pricing"],
      link: "https://book.me/x",
      valueCents: 1000,
    },
  } as unknown as Parameters<typeof attemptAutoReply>[1];
}

const interaction = {
  id: "int-1",
  workspace_id: "ws-1",
  channel: "x",
  external_id: "ext-1",
  parent_post_id: null,
  author_handle: "stranger",
  author_display_name: "Stranger",
  body: "what is your pricing?",
  status: "unread",
} as unknown as Parameters<typeof attemptAutoReply>[2];

beforeEach(() => {
  draftReplyMock.mockResolvedValue({
    drafts: ["Thanks for asking — here's the info!"],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  sendReplyViaChannelMock.mockResolvedValue({ externalId: "sent-ext", postId: "post-1" });
  xResolveUsernameMock.mockResolvedValue({ id: "999" });
  loadFreshXCredentialsMock.mockResolvedValue({});
  xSendDmMock.mockResolvedValue({ id: "dm-1" });
  blueskySendDmMock.mockResolvedValue({ id: "dm-1" });
  linkedinSendDmMock.mockResolvedValue({ id: "dm-1" });
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── Pure policy: shadow ENGAGES the gate but does NOT authorise a send ──────

describe("policy mode primitives", () => {
  it("parseEngagementMode is fail-closed (unknown → off)", () => {
    expect(parseEngagementMode("live")).toBe("live");
    expect(parseEngagementMode("shadow")).toBe("shadow");
    expect(parseEngagementMode("off")).toBe("off");
    expect(parseEngagementMode(undefined)).toBe("off");
    expect(parseEngagementMode(null)).toBe("off");
    expect(parseEngagementMode("LIVE")).toBe("off");
    expect(parseEngagementMode(true)).toBe("off");
  });

  it("shadow ENGAGES (drafts + gates) but does NOT send", () => {
    expect(modeEngages("shadow")).toBe(true);
    expect(modeSends("shadow")).toBe(false);
  });
  it("live both engages AND sends", () => {
    expect(modeEngages("live")).toBe(true);
    expect(modeSends("live")).toBe(true);
  });
  it("off neither engages nor sends", () => {
    expect(modeEngages("off")).toBe(false);
    expect(modeSends("off")).toBe(false);
  });

  it("the shared gate passes identically for shadow and live (engaged=true)", () => {
    const base = {
      channel: "x",
      trustMode: true,
      killSwitch: false,
      interactionStatus: "unread",
      hasDraft: true,
    };
    // The orchestrator passes modeEngages(mode) as autoReplyEnabled and
    // modeSends(mode) as isLive. With trust ON, both shadow and live pass.
    const shadow = evaluateAutoReplyGate({
      ...base,
      autoReplyEnabled: modeEngages("shadow"),
      isLive: modeSends("shadow"),
    });
    const live = evaluateAutoReplyGate({
      ...base,
      autoReplyEnabled: modeEngages("live"),
      isLive: modeSends("live"),
    });
    expect(shadow.send).toBe(true);
    expect(live.send).toBe(true);
  });
});

// ── auto-reply orchestrator ─────────────────────────────────────────────────

describe("attemptAutoReply — SHADOW", () => {
  it("drafts + audits outcome='shadow' but NEVER calls the channel send", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptAutoReply(svc, account("shadow"), interaction, false, voice);

    expect(res.outcome).toBe("shadow");
    // PROOF: the channel send helper was never invoked. Zero blast radius.
    expect(sendReplyViaChannelMock).not.toHaveBeenCalled();
    // The drafter DID run — shadow generates the would-send text.
    expect(draftReplyMock).toHaveBeenCalledTimes(1);
    // Exactly one audit row, outcome='shadow', with the would-send text.
    expect(logInserts.length).toBe(1);
    expect(logInserts[0].outcome).toBe("shadow");
    expect(logInserts[0].would_send_text).toBe("Thanks for asking — here's the info!");
    expect(logInserts[0].external_id).toBeNull();
    // The interaction is NOT flipped — it stays a live suggestion.
    expect(interactionUpdates.length).toBe(0);
  });

  it("is NOT rate-limited: shadow fires even when the hour is FULL of sent rows", async () => {
    // Fill the rate window with `sent` rows well past the X cap (5). A LIVE
    // account would be rate_capped here; shadow must still draft + audit
    // because shadow never hits the platform.
    const sent = Array.from({ length: 50 }, () => ({
      created_at: new Date().toISOString(),
    }));
    const { svc, logInserts } = fakeSvc(sent);
    const res = await attemptAutoReply(svc, account("shadow"), interaction, false, voice);

    expect(res.outcome).toBe("shadow");
    expect(res.reason).not.toBe("rate_capped");
    expect(sendReplyViaChannelMock).not.toHaveBeenCalled();
    expect(logInserts[0].outcome).toBe("shadow");
  });

  it("respects the kill switch (no draft, no send) even in shadow", async () => {
    const { svc, logInserts } = fakeSvc();
    const res = await attemptAutoReply(svc, account("shadow"), interaction, true, voice);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("kill_switch");
    expect(draftReplyMock).not.toHaveBeenCalled();
    expect(sendReplyViaChannelMock).not.toHaveBeenCalled();
    // Kill switch is an active-but-held state for an engaged account → logged.
    expect(logInserts[0]?.outcome).toBe("blocked");
  });
});

describe("attemptAutoReply — LIVE still sends + flips", () => {
  it("calls the channel send, audits outcome='sent', flips to replied", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptAutoReply(svc, account("live"), interaction, false, voice);

    expect(res.outcome).toBe("sent");
    expect(sendReplyViaChannelMock).toHaveBeenCalledTimes(1);
    expect(logInserts[0].outcome).toBe("sent");
    // sent rows don't carry would_send_text (that column is shadow-only).
    expect(logInserts[0].would_send_text).toBeNull();
    // The interaction IS flipped to replied.
    expect(interactionUpdates.length).toBe(1);
    expect(interactionUpdates[0].status).toBe("replied");
  });

  it("LIVE is rate-limited when the hour is full (proving the cap still bites)", async () => {
    const sent = Array.from({ length: 50 }, () => ({
      created_at: new Date().toISOString(),
    }));
    const { svc } = fakeSvc(sent);
    const res = await attemptAutoReply(svc, account("live"), interaction, false, voice);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("rate_capped");
    expect(sendReplyViaChannelMock).not.toHaveBeenCalled();
  });
});

describe("attemptAutoReply — OFF no-ops", () => {
  it("does nothing: no draft, no send, no flip, no audit spam", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptAutoReply(svc, account("off"), interaction, false, voice);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("not_opted_in");
    expect(draftReplyMock).not.toHaveBeenCalled();
    expect(sendReplyViaChannelMock).not.toHaveBeenCalled();
    expect(interactionUpdates.length).toBe(0);
    // Off is the steady-state rejection → NOT logged (no audit spam).
    expect(logInserts.length).toBe(0);
  });
});

// ── comment→DM orchestrator ─────────────────────────────────────────────────

describe("attemptLeadCaptureDm — SHADOW", () => {
  it("builds the DM + audits outcome='shadow' but NEVER calls any DM helper", async () => {
    const { svc, logInserts, interactionUpdates, outcomeInserts } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, account("shadow"), interaction, false);

    expect(res.outcome).toBe("shadow");
    expect(res.matchedKeyword).toBe("pricing");
    expect(res.leadTagged).toBe(false);
    // PROOF: no channel DM helper was ever invoked.
    expect(xSendDmMock).not.toHaveBeenCalled();
    expect(blueskySendDmMock).not.toHaveBeenCalled();
    expect(linkedinSendDmMock).not.toHaveBeenCalled();
    // Exactly one audit row, outcome='shadow', with the would-send DM text.
    expect(logInserts.length).toBe(1);
    expect(logInserts[0].outcome).toBe("shadow");
    expect(typeof logInserts[0].would_send_text).toBe("string");
    expect(logInserts[0].lead_tagged).toBe(false);
    // No lead tagged, interaction NOT flipped.
    expect(outcomeInserts.length).toBe(0);
    expect(interactionUpdates.length).toBe(0);
  });

  it("is NOT rate-limited: shadow DM fires even with the hour full of sent DMs", async () => {
    const sent = Array.from({ length: 50 }, () => ({
      created_at: new Date().toISOString(),
    }));
    const { svc, logInserts } = fakeSvc(sent);
    const res = await attemptLeadCaptureDm(svc, account("shadow"), interaction, false);
    expect(res.outcome).toBe("shadow");
    expect(res.reason).not.toBe("rate_capped");
    expect(xSendDmMock).not.toHaveBeenCalled();
    expect(logInserts[0].outcome).toBe("shadow");
  });
});

describe("attemptLeadCaptureDm — LIVE still sends + flips", () => {
  it("calls the X DM helper, audits sent, tags lead, flips to read", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, account("live"), interaction, false);

    expect(res.outcome).toBe("sent");
    expect(xSendDmMock).toHaveBeenCalledTimes(1);
    expect(logInserts[0].outcome).toBe("sent");
    expect(logInserts[0].would_send_text).toBeNull();
    // The DM path flips the interaction to 'read' (not 'replied').
    expect(interactionUpdates.length).toBe(1);
    expect(interactionUpdates[0].status).toBe("read");
  });
});

describe("attemptLeadCaptureDm — OFF no-ops", () => {
  it("does nothing: no DM helper call, no flip, no audit spam", async () => {
    const { svc, logInserts, interactionUpdates } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, account("off"), interaction, false);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("not_opted_in");
    expect(xSendDmMock).not.toHaveBeenCalled();
    expect(interactionUpdates.length).toBe(0);
    expect(logInserts.length).toBe(0);
  });
});

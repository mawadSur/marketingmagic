import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Bet 4 — comment→DM: the per-channel CAPABILITY (scope) GUARD ───────────
//
// The load-bearing safety property: BEFORE attempting any DM, each channel's
// helper checks whether the connected account actually has DM capability. When
// it doesn't, it must NO-OP cleanly — throw DmScopeMissingError (which the
// orchestrator turns into outcome='scope_missing'), never a hard failure, and
// never send. These exercise:
//   * X       — static guard (recorded scope lacks dm.write) + dynamic guard
//               (403/453 from the API) + unknown-scope dynamic path.
//   * Bluesky — chat access denied on the app password (chat.bsky.* 403).
//   * LinkedIn— messaging partnership-gated → always absent (no network).
//   * Orchestrator — a scope-missing send is recorded once, no lead tagged,
//     and the interaction is NOT flipped.

const env: Record<string, string | undefined> = {};
function resetEnv() {
  for (const k of Object.keys(env)) delete env[k];
  env.X_CLIENT_ID = "x-id";
  env.X_CLIENT_SECRET = "x-secret";
}
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

import {
  xDmCapability,
  xSendDm,
  type XCredentials,
  type XCredentialsLegacy,
} from "@/lib/social/x";
import { blueskySendDm, blueskyDmCapability } from "@/lib/social/bluesky";
import { linkedinDmCapability, linkedinSendDm, type LinkedInCredentials } from "@/lib/social/linkedin";
import { DmScopeMissingError } from "@/lib/interactions/errors";
import { attemptLeadCaptureDm } from "@/lib/interactions/auto-reply/dm-send";

// ── fetch stub (queued responders, same idiom as channel-token-exchange) ────
interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}
let calls: RecordedCall[] = [];
let responders: Array<(url: string, init?: RequestInit) => Response> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  resetEnv();
  calls = [];
  responders = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const responder = responders.shift();
    if (!responder) throw new Error(`Unexpected fetch with no queued responder: ${url}`);
    return Promise.resolve(responder(url, init));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const freshXCreds = (scope?: string): XCredentials =>
  ({ accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 60 * 60 * 1000, ...(scope ? { scope } : {}) } as XCredentials);

// ── X ───────────────────────────────────────────────────────────────────────

describe("X DM capability guard", () => {
  it("xDmCapability: recorded scope WITHOUT dm.write → not granted (no network)", () => {
    const cap = xDmCapability(freshXCreds("tweet.read tweet.write users.read"));
    expect(cap.granted).toBe(false);
    expect(cap.reason).toBe("scope_missing_dm_write");
  });

  it("xDmCapability: recorded scope WITH dm.write → granted", () => {
    const cap = xDmCapability(freshXCreds("tweet.write dm.write offline.access"));
    expect(cap.granted).toBe(true);
  });

  it("xDmCapability: legacy OAuth 1.0a creds → not granted", () => {
    const legacy: XCredentialsLegacy = {
      apiKey: "k",
      apiSecret: "s",
      accessToken: "a",
      accessTokenSecret: "ats",
    };
    expect(xDmCapability(legacy).reason).toBe("legacy_oauth1_no_dm");
  });

  it("xSendDm: static guard short-circuits when scope known-absent — NO network call", async () => {
    await expect(
      xSendDm(freshXCreds("tweet.write users.read"), "12345", "hi"),
    ).rejects.toBeInstanceOf(DmScopeMissingError);
    expect(calls.length).toBe(0); // never hit the API
  });

  it("xSendDm: dynamic guard maps a 403 to DmScopeMissingError (unknown scope path)", async () => {
    // No recorded scope → attempt the send → API says no access (403).
    responders.push(() => textResponse("Unsupported Authentication", 403));
    await expect(
      xSendDm(freshXCreds(), "12345", "hi"),
    ).rejects.toBeInstanceOf(DmScopeMissingError);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/2/dm_conversations/with/12345/messages");
  });

  it("xSendDm: 453 access-level error also maps to DmScopeMissingError", async () => {
    responders.push(() => textResponse("client-not-enrolled", 453));
    await expect(xSendDm(freshXCreds(), "999", "hi")).rejects.toBeInstanceOf(
      DmScopeMissingError,
    );
  });

  it("xSendDm: succeeds on a 201 when the API accepts it", async () => {
    responders.push(() => jsonResponse({ dm_conversation_id: "c1", dm_event_id: "e1" }, 201));
    const r = await xSendDm(freshXCreds("dm.write"), "12345", "hi");
    expect(r.id).toBe("c1");
    expect(r.event_id).toBe("e1");
  });
});

// ── Bluesky ───────────────────────────────────────────────────────────────

const bskyCreds = { handle: "me.bsky.social", appPassword: "app-pw" };

describe("Bluesky DM capability guard", () => {
  it("blueskyDmCapability: chat access denied (403) on the app password → not granted", async () => {
    responders.push(() => jsonResponse({ accessJwt: "jwt", refreshJwt: "r", did: "did:plc:me" })); // createSession
    responders.push(() => jsonResponse({ did: "did:plc:them" })); // resolveHandle
    responders.push(() => textResponse(JSON.stringify({ error: "InvalidToken" }), 403)); // getConvoForMembers
    const cap = await blueskyDmCapability(bskyCreds, "them.bsky.social");
    expect(cap.granted).toBe(false);
    expect(cap.reason).toBe("chat_access_denied_app_password");
  });

  it("blueskySendDm: NO-OPs (DmScopeMissingError) when chat is denied — never calls sendMessage", async () => {
    responders.push(() => jsonResponse({ accessJwt: "jwt", refreshJwt: "r", did: "did:plc:me" })); // createSession
    responders.push(() => jsonResponse({ did: "did:plc:them" })); // resolveHandle
    responders.push(() => textResponse(JSON.stringify({ error: "InvalidToken" }), 403)); // getConvoForMembers
    await expect(
      blueskySendDm(bskyCreds, "them.bsky.social", "hi"),
    ).rejects.toBeInstanceOf(DmScopeMissingError);
    // 3 calls: session + resolve + getConvoForMembers. sendMessage never fires.
    expect(calls.length).toBe(3);
    expect(calls.some((c) => c.url.includes("chat.bsky.convo.sendMessage"))).toBe(false);
  });

  it("blueskySendDm: sends when chat is available (proxy header set)", async () => {
    responders.push(() => jsonResponse({ accessJwt: "jwt", refreshJwt: "r", did: "did:plc:me" })); // createSession
    responders.push(() => jsonResponse({ did: "did:plc:them" })); // resolveHandle
    responders.push(() => jsonResponse({ convo: { id: "convo-1" } })); // getConvoForMembers
    responders.push(() => jsonResponse({ id: "msg-1" })); // sendMessage
    const r = await blueskySendDm(bskyCreds, "them.bsky.social", "hi");
    expect(r.id).toBe("convo-1");
    expect(r.messageId).toBe("msg-1");
    // The convo + send calls carry the chat proxy header.
    const sendCall = calls.find((c) => c.url.includes("chat.bsky.convo.sendMessage"));
    expect(sendCall).toBeDefined();
    const headers = sendCall!.init?.headers as Record<string, string>;
    expect(headers["atproto-proxy"]).toBe("did:web:api.bsky.chat#bsky_chat");
  });
});

// ── LinkedIn (partnership-gated; always absent today) ───────────────────────

const liCreds: LinkedInCredentials = {
  accessToken: "tok",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  memberUrn: "urn:li:person:me",
  grantedScopes: "openid profile w_member_social",
};

describe("LinkedIn DM capability guard", () => {
  it("linkedinDmCapability: standard w_member_social token → not granted", () => {
    const cap = linkedinDmCapability(liCreds);
    expect(cap.granted).toBe(false);
    expect(cap.reason).toBe("messaging_partnership_required");
  });

  it("linkedinSendDm: ALWAYS no-ops (DmScopeMissingError) with NO network call", async () => {
    await expect(
      linkedinSendDm(liCreds, "urn:li:person:them", "hi"),
    ).rejects.toBeInstanceOf(DmScopeMissingError);
    expect(calls.length).toBe(0);
  });
});

// ── Orchestrator: a scope-missing send is a clean, audited no-op ────────────

// Minimal fluent fake service client. Records dm_capture_log inserts +
// interactions updates. Returns empty for the rate-cap select.
function fakeSvc() {
  const logInserts: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const outcomeInserts: Array<Record<string, unknown>> = [];
  const svc = {
    from(table: string) {
      if (table === "dm_capture_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            logInserts.push(row);
            return Promise.resolve({ error: null });
          },
          // rate-cap select chain → resolves to no prior sends.
          select: () => ({
            eq: () => ({
              eq: () => ({ gte: () => Promise.resolve({ data: [] }) }),
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

const liAccount = {
  id: "acct-li",
  workspace_id: "ws-1",
  channel: "linkedin",
  handle: "company",
  credentials: liCreds as unknown,
  trust_mode: true,
  dm_capture_enabled: true,
  lead_keyword_rule: { keywords: ["pricing"], link: "https://book.me/x", valueCents: 1000 },
} as unknown as Parameters<typeof attemptLeadCaptureDm>[1];

const matchingInteraction = {
  id: "int-1",
  workspace_id: "ws-1",
  channel: "linkedin",
  author_handle: "urn:li:person:them",
  body: "what is your pricing?",
  status: "unread",
  parent_post_id: "post-1",
} as unknown as Parameters<typeof attemptLeadCaptureDm>[2];

describe("attemptLeadCaptureDm — scope-missing path is a clean no-op", () => {
  it("LinkedIn (gated): records outcome='scope_missing', tags NO lead, does NOT flip the row", async () => {
    const { svc, logInserts, interactionUpdates, outcomeInserts } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, liAccount, matchingInteraction, false);

    expect(res.outcome).toBe("scope_missing");
    expect(res.matchedKeyword).toBe("pricing");
    expect(res.leadTagged).toBe(false);

    // Exactly one audit row, recording the scope.
    expect(logInserts.length).toBe(1);
    expect(logInserts[0].outcome).toBe("scope_missing");
    expect(logInserts[0].outcome_reason).toBe("linkedin_messaging");
    expect(logInserts[0].lead_tagged).toBe(false);

    // No lead tagged, and the interaction is NOT flipped (scope-miss isn't a
    // successful action — leave it for the human / future re-attempt).
    expect(outcomeInserts.length).toBe(0);
    expect(interactionUpdates.length).toBe(0);
  });

  it("holds (blocked, no audit spam) when the account hasn't opted in", async () => {
    const notOptedIn = { ...liAccount, dm_capture_enabled: false } as typeof liAccount;
    const { svc, logInserts } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, notOptedIn, matchingInteraction, false);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("not_opted_in");
    // Not opted in → steady-state rejection → NOT logged (no audit spam).
    expect(logInserts.length).toBe(0);
  });

  it("respects the workspace kill switch (blocked, kill_switch)", async () => {
    const { svc } = fakeSvc();
    const res = await attemptLeadCaptureDm(svc, liAccount, matchingInteraction, true);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("kill_switch");
  });
});

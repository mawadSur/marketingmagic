import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Integration: per-channel token exchange / refresh / verify (mocked fetch) ─
//
// These exercise the REAL adapter HTTP plumbing with a stubbed global.fetch.
// What we pin per channel:
//   - exchange hits the right TOKEN endpoint with the right auth scheme
//     (X/LinkedIn = body creds; X also Basic-auths; TikTok = client_key in body)
//   - refresh rotates tokens and the loadFresh* helpers (a) skip when fresh,
//     (b) refresh + persist via the service client when stale
//   - verify resolves the connected handle/urn from the provider response
//
// The service Supabase client is faked as a fluent .from().update().eq() spy so
// we can assert credentials get persisted back without a real DB.

const env: Record<string, string | undefined> = {};
function resetEnv() {
  for (const k of Object.keys(env)) delete env[k];
  env.X_CLIENT_ID = "x-id";
  env.X_CLIENT_SECRET = "x-secret";
  env.TIKTOK_CLIENT_KEY = "tt-key";
  env.TIKTOK_CLIENT_SECRET = "tt-secret";
  env.LINKEDIN_CLIENT_ID = "li-id";
  env.LINKEDIN_CLIENT_SECRET = "li-secret";
}
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

import {
  xExchangeCode,
  xRefreshToken,
  xVerify,
  loadFreshXCredentials,
  type XCredentials,
} from "@/lib/social/x";
import {
  tiktokExchangeCode,
  tiktokRefreshToken,
  tiktokVerify,
  loadFreshTikTokCredentials,
  type TikTokCredentials,
} from "@/lib/social/tiktok";
import { linkedinExchangeCode, linkedinVerify } from "@/lib/social/linkedin";

// ── fetch stub ────────────────────────────────────────────────────────────────
// Each test pushes a queue of responder fns. The stub records every call
// (url + init) and returns the next queued response, so assertions can inspect
// exactly what the adapter sent.
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

// Build a fake service client whose .from(t).update(p).eq(c, v) resolves and
// records the update payload for assertions.
function fakeSvc(): { svc: SupabaseClient; updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const svc = {
    from() {
      return {
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { svc, updates };
}

// Decode a URLSearchParams body (string) back into an object for assertions.
function bodyParams(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("X token lifecycle", () => {
  it("exchangeCode POSTs to the /2/oauth2/token endpoint with Basic auth + PKCE verifier", async () => {
    responders.push(() =>
      jsonResponse({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "AT",
        refresh_token: "RT",
        scope: "tweet.write offline.access",
      }),
    );
    const tok = await xExchangeCode({
      clientId: "x-id",
      clientSecret: "x-secret",
      code: "the-code",
      codeVerifier: "verifier",
      redirectUri: "https://app/cb",
    });
    expect(tok.access_token).toBe("AT");
    expect(tok.refresh_token).toBe("RT");

    const call = calls[0]!;
    expect(call.url).toBe("https://api.twitter.com/2/oauth2/token");
    const headers = call.init!.headers as Record<string, string>;
    // Confidential client → HTTP Basic auth with clientId:clientSecret.
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("x-id:x-secret").toString("base64")}`,
    );
    const body = bodyParams(call.init);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("verifier");
  });

  it("exchangeCode throws on a non-2xx token response", async () => {
    responders.push(() => new Response("bad request", { status: 400 }));
    await expect(
      xExchangeCode({
        clientId: "x-id",
        clientSecret: "x-secret",
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://app/cb",
      }),
    ).rejects.toThrow(/X token exchange failed \(400\)/);
  });

  it("refreshToken sends grant_type=refresh_token and returns rotated tokens", async () => {
    responders.push(() =>
      jsonResponse({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "AT2",
        refresh_token: "RT2",
        scope: "tweet.write",
      }),
    );
    const tok = await xRefreshToken({
      clientId: "x-id",
      clientSecret: "x-secret",
      refreshToken: "RT",
    });
    expect(tok.access_token).toBe("AT2");
    expect(bodyParams(calls[0]!.init).get("grant_type")).toBe("refresh_token");
  });

  it("loadFresh skips refresh when the token is comfortably fresh (no fetch)", async () => {
    const { svc, updates } = fakeSvc();
    const fresh: XCredentials = {
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h out
    };
    const out = await loadFreshXCredentials(svc, "acct-1", fresh);
    expect(out).toBe(fresh);
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("loadFresh refreshes + persists when within the 5-minute expiry leeway", async () => {
    const { svc, updates } = fakeSvc();
    responders.push(() =>
      jsonResponse({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "AT-new",
        refresh_token: "RT-new",
        scope: "tweet.write",
      }),
    );
    const stale: XCredentials = {
      accessToken: "AT-old",
      refreshToken: "RT-old",
      expiresAt: Date.now() + 60 * 1000, // 1 min out → inside the 5-min leeway
    };
    const out = (await loadFreshXCredentials(svc, "acct-1", stale)) as XCredentials;
    expect(out.accessToken).toBe("AT-new");
    expect(out.refreshToken).toBe("RT-new");
    // Persisted back to social_accounts via the service client.
    expect(updates).toHaveLength(1);
    expect((updates[0]!.credentials as XCredentials).accessToken).toBe("AT-new");
  });

  it("loadFresh keeps the old refresh token when X omits a rotated one", async () => {
    const { svc } = fakeSvc();
    responders.push(() =>
      jsonResponse({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "AT-new",
        // no refresh_token → fall back to the existing one
        scope: "tweet.write",
      }),
    );
    const stale: XCredentials = {
      accessToken: "AT-old",
      refreshToken: "RT-keep",
      expiresAt: Date.now() + 1000,
    };
    const out = (await loadFreshXCredentials(svc, "acct-1", stale)) as XCredentials;
    expect(out.refreshToken).toBe("RT-keep");
  });

  it("verify resolves { id, username } from /2/users/me", async () => {
    responders.push(() => jsonResponse({ data: { id: "42", username: "mawad1004" } }));
    const v = await xVerify({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 1e6 });
    expect(v).toEqual({ id: "42", username: "mawad1004" });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer AT");
  });
});

describe("TikTok token lifecycle (client_key in body, 24h tokens)", () => {
  it("exchangeCode posts client_key (NOT client_id) + code_verifier to open.tiktokapis.com", async () => {
    responders.push(() =>
      jsonResponse({
        access_token: "AT",
        expires_in: 86400,
        refresh_token: "RT",
        refresh_expires_in: 31536000,
        open_id: "open-1",
        scope: "user.info.basic,video.publish,video.upload",
        token_type: "Bearer",
      }),
    );
    const tok = await tiktokExchangeCode({
      clientKey: "tt-key",
      clientSecret: "tt-secret",
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://app/cb",
    });
    expect(tok.access_token).toBe("AT");
    expect(calls[0]!.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    const body = bodyParams(calls[0]!.init);
    expect(body.get("client_key")).toBe("tt-key");
    expect(body.get("client_id")).toBeNull();
    expect(body.get("code_verifier")).toBe("v");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("loadFresh refreshes a stale 24h token, persisting the rotated refresh token", async () => {
    const { svc, updates } = fakeSvc();
    responders.push(() =>
      jsonResponse({
        access_token: "AT-new",
        expires_in: 86400,
        refresh_token: "RT-rotated",
        refresh_expires_in: 31536000,
        open_id: "open-1",
        scope: "user.info.basic",
        token_type: "Bearer",
      }),
    );
    const stale: TikTokCredentials = {
      accessToken: "AT-old",
      refreshToken: "RT-old",
      expiresAt: Date.now() + 60 * 1000,
    };
    const out = await loadFreshTikTokCredentials(svc, "acct-1", stale);
    expect(out.accessToken).toBe("AT-new");
    expect(out.refreshToken).toBe("RT-rotated");
    expect((updates[0]!.credentials as TikTokCredentials).refreshToken).toBe("RT-rotated");
    expect(bodyParams(calls[0]!.init).get("grant_type")).toBe("refresh_token");
  });

  it("loadFresh skips refresh when fresh", async () => {
    const { svc } = fakeSvc();
    const fresh: TikTokCredentials = {
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    };
    await loadFreshTikTokCredentials(svc, "acct-1", fresh);
    expect(calls.length).toBe(0);
  });

  it("verify resolves { openId, handle } from /v2/user/info", async () => {
    responders.push(() =>
      jsonResponse({ data: { user: { open_id: "open-1", display_name: "mm" } } }),
    );
    const v = await tiktokVerify({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 1e9 });
    expect(v).toEqual({ openId: "open-1", handle: "mm" });
  });

  it("refresh throws a clear error when keys are unset", async () => {
    delete env.TIKTOK_CLIENT_KEY;
    const { svc } = fakeSvc();
    const stale: TikTokCredentials = {
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: Date.now() + 1000,
    };
    await expect(loadFreshTikTokCredentials(svc, "acct-1", stale)).rejects.toThrow(
      /TIKTOK_CLIENT_KEY \/ TIKTOK_CLIENT_SECRET not set/,
    );
  });
});

describe("LinkedIn token lifecycle", () => {
  it("exchangeCode posts client creds to the accessToken endpoint and returns granted scope", async () => {
    responders.push(() =>
      jsonResponse({
        access_token: "AT",
        expires_in: 5184000,
        scope: "openid profile w_member_social",
        token_type: "Bearer",
      }),
    );
    const tok = await linkedinExchangeCode({ code: "c", redirectUri: "https://app/cb" });
    expect(tok.access_token).toBe("AT");
    // The granted scope tells the callback whether org-posting was approved.
    expect(tok.scope).toBe("openid profile w_member_social");
    expect(calls[0]!.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    const body = bodyParams(calls[0]!.init);
    expect(body.get("client_id")).toBe("li-id");
    expect(body.get("client_secret")).toBe("li-secret");
  });

  it("verify builds a person URN from the OpenID userinfo `sub`", async () => {
    responders.push(() => jsonResponse({ sub: "abc123", name: "Mohammed Awad" }));
    const v = await linkedinVerify("AT");
    expect(v.urn).toBe("urn:li:person:abc123");
    expect(v.name).toBe("Mohammed Awad");
  });
});

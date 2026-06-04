import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Integration: Meta-family + Bluesky connect lifecycle (mocked fetch) ───────
//
// Completes the 7-channel connect coverage that channel-token-exchange.test.ts
// started (X / TikTok / LinkedIn). Here we pin the Meta Graph token exchanges
// and verify calls, plus Bluesky's app-password session:
//   - Facebook: code → short token → long token → /me/accounts page listing,
//     returning the candidate Pages the picker chooses from.
//   - Instagram: code → short token (api.instagram.com) → long token
//     (graph.instagram.com), verify via /me.
//   - Threads: code → short token → long token, verify via /{userId}.
//   - Bluesky: createSession (app password) used by verify; no OAuth.

const env: Record<string, string | undefined> = {};
function resetEnv() {
  for (const k of Object.keys(env)) delete env[k];
  env.META_APP_ID = "meta-id";
  env.META_APP_SECRET = "meta-secret";
  env.INSTAGRAM_APP_ID = "ig-id";
  env.INSTAGRAM_APP_SECRET = "ig-secret";
  env.THREADS_APP_ID = "th-id";
  env.THREADS_APP_SECRET = "th-secret";
}
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

import { facebookExchangeCode, facebookVerify } from "@/lib/social/facebook";
import { instagramExchangeCode, instagramVerify } from "@/lib/social/instagram";
import { threadsExchangeCode, threadsVerify } from "@/lib/social/threads";
import { blueskyVerify } from "@/lib/social/bluesky";

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

describe("Facebook connect (3-hop: short token → long token → page listing)", () => {
  it("returns the publishable Page candidates with their page-scoped tokens", async () => {
    responders.push(
      () => jsonResponse({ access_token: "short-tok", expires_in: 3600 }), // code → short
      () => jsonResponse({ access_token: "long-tok", expires_in: 5184000 }), // short → long
      () =>
        jsonResponse({
          data: [
            { id: "page-1", name: "Pitch Pit", access_token: "page-tok-1", tasks: ["CREATE_CONTENT"] },
            { id: "page-2", name: "Other", access_token: "page-tok-2", tasks: ["ANALYZE"] },
          ],
        }), // /me/accounts
    );
    const result = await facebookExchangeCode({ code: "c", redirectUri: "https://app/cb" });
    // Only the CREATE_CONTENT page is publishable.
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      pageId: "page-1",
      pageName: "Pitch Pit",
      pageAccessToken: "page-tok-1",
    });
    // The /me/accounts call carried the LONG-lived user token, not the short one.
    expect(calls[2]!.url).toContain("access_token=long-tok");
  });

  it("throws when the account manages no Pages", async () => {
    responders.push(
      () => jsonResponse({ access_token: "short-tok" }),
      () => jsonResponse({ access_token: "long-tok" }),
      () => jsonResponse({ data: [] }),
    );
    await expect(
      facebookExchangeCode({ code: "c", redirectUri: "https://app/cb" }),
    ).rejects.toThrow(/No Facebook Pages found/);
  });

  it("verify resolves the Page name from /{pageId}", async () => {
    responders.push(() => jsonResponse({ name: "Pitch Pit" }));
    const v = await facebookVerify("page-1", "page-tok");
    expect(v.name).toBe("Pitch Pit");
    expect(calls[0]!.url).toContain("/page-1?fields=name");
  });
});

describe("Instagram connect (IG Login flow)", () => {
  it("exchanges code → short token (api.instagram.com) → long token (graph.instagram.com)", async () => {
    responders.push(
      () => jsonResponse({ access_token: "short", user_id: 17841405822304914 }),
      () => jsonResponse({ access_token: "long-ig", expires_in: 5184000 }),
    );
    const out = await instagramExchangeCode({ code: "c", redirectUri: "https://app/cb" });
    expect(out.accessToken).toBe("long-ig");
    // user_id arrives as a JSON number — must be coerced to string for storage.
    expect(out.igUserId).toBe("17841405822304914");
    expect(typeof out.igUserId).toBe("string");
    expect(calls[0]!.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[1]!.url).toContain("graph.instagram.com/access_token");
    expect(calls[1]!.url).toContain("grant_type=ig_exchange_token");
  });

  it("verify resolves the IG username from /me", async () => {
    responders.push(() => jsonResponse({ username: "mohammed_awad_atl", user_id: "ig-1" }));
    const v = await instagramVerify("AT", "ig-1");
    expect(v.username).toBe("mohammed_awad_atl");
  });
});

describe("Threads connect", () => {
  it("exchanges code → short token → long token and records a future expiry", async () => {
    responders.push(
      () => jsonResponse({ access_token: "short", user_id: "th-user-1" }),
      () => jsonResponse({ access_token: "long-th", expires_in: 5184000 }),
    );
    const out = await threadsExchangeCode({ code: "c", redirectUri: "https://app/cb" });
    expect(out.accessToken).toBe("long-th");
    expect(out.userId).toBe("th-user-1");
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(calls[0]!.url).toBe("https://graph.threads.net/oauth/access_token");
    expect(calls[1]!.url).toContain("grant_type=th_exchange_token");
  });

  it("verify resolves the Threads username", async () => {
    responders.push(() => jsonResponse({ username: "mawad.threads" }));
    const v = await threadsVerify("AT", "th-user-1");
    expect(v.username).toBe("mawad.threads");
  });
});

describe("Bluesky connect (app-password session)", () => {
  it("verify creates a session and returns { handle, did }", async () => {
    responders.push(() =>
      jsonResponse({ accessJwt: "jwt", refreshJwt: "rjwt", did: "did:plc:abc" }),
    );
    const v = await blueskyVerify({ handle: "mm.bsky.social", appPassword: "xxxx-xxxx" });
    expect(v).toEqual({ handle: "mm.bsky.social", did: "did:plc:abc" });
    expect(calls[0]!.url).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    // The handle + app password go in the createSession body as identifier/password.
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.identifier).toBe("mm.bsky.social");
    expect(body.password).toBe("xxxx-xxxx");
  });

  it("verify throws on a bad app password (401 from createSession)", async () => {
    responders.push(() => new Response("Unauthorized", { status: 401 }));
    await expect(
      blueskyVerify({ handle: "mm.bsky.social", appPassword: "wrong" }),
    ).rejects.toThrow(/Bluesky session failed \(401\)/);
  });
});

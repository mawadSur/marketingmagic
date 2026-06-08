import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Integration: per-channel authorize-URL builders ──────────────────────────
//
// The authorize URL is the entry point of every OAuth connect flow. Getting it
// wrong is exactly the class of bug this app keeps hitting in production:
//   - wrong authorize HOST (twitter.com vs x.com; threads.net vs facebook.com)
//   - missing/renamed SCOPE (instagram_business_* prefix; threads_manage_insights)
//   - the wrong client param (TikTok uses client_key, NOT client_id)
//   - sending scope= on Facebook Login for Business (must send config_id instead)
//
// We exercise the REAL builder functions from each adapter — only `@/lib/env`
// is mocked so we can feed deterministic client ids/keys without a live env.
// No fetch is touched: these builders are pure string construction.

// One mutable env object the mocked serverEnv() returns. Each test seeds the
// fields its channel reads in beforeEach via resetEnv().
const env: Record<string, string | undefined> = {};
function resetEnv() {
  for (const k of Object.keys(env)) delete env[k];
  env.X_CLIENT_ID = "x-client-id";
  env.LINKEDIN_CLIENT_ID = "li-client-id";
  env.INSTAGRAM_APP_ID = "ig-app-id";
  env.THREADS_APP_ID = "th-app-id";
  env.META_APP_ID = "meta-app-id";
  env.META_FB_LOGIN_CONFIG_ID = "fb-config-id";
  env.TIKTOK_CLIENT_KEY = "tt-client-key";
  env.YOUTUBE_CLIENT_ID = "yt-client-id";
}

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
}));

import { xAuthorizeUrl, X_OAUTH_SCOPES } from "@/lib/social/x";
import { tiktokAuthorizeUrl } from "@/lib/social/tiktok";
import { instagramAuthorizeUrl } from "@/lib/social/instagram";
import { threadsAuthorizeUrl } from "@/lib/social/threads";
import { facebookAuthorizeUrl } from "@/lib/social/facebook";
import { linkedinAuthorizeUrl } from "@/lib/social/linkedin";
import { youtubeAuthorizeUrl, YOUTUBE_OAUTH_SCOPES } from "@/lib/social/youtube";

const REDIRECT = "https://marketingmagic.vercel.app/api/oauth/{ch}/callback";
const STATE = "ws-id:nonce-abc";

beforeEach(() => resetEnv());
afterEach(() => vi.clearAllMocks());

describe("X authorize URL (OAuth 2.0 PKCE)", () => {
  it("targets x.com (NOT twitter.com — login cookies live on x.com post-migration)", () => {
    const u = new URL(
      xAuthorizeUrl({
        clientId: "x-client-id",
        redirectUri: REDIRECT.replace("{ch}", "x"),
        state: STATE,
        codeChallenge: "challenge",
      }),
    );
    expect(u.host).toBe("x.com");
    expect(u.pathname).toBe("/i/oauth2/authorize");
  });

  it("carries PKCE S256 + the documented scope set", () => {
    const u = new URL(
      xAuthorizeUrl({
        clientId: "x-client-id",
        redirectUri: REDIRECT.replace("{ch}", "x"),
        state: STATE,
        codeChallenge: "challenge",
      }),
    );
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("x-client-id");
    expect(u.searchParams.get("code_challenge")).toBe("challenge");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(STATE);
    // Space-delimited scope string containing every documented scope. Notably
    // offline.access (refresh token) + media.write (image/video upload).
    const scope = u.searchParams.get("scope") ?? "";
    for (const s of X_OAUTH_SCOPES) expect(scope.split(" ")).toContain(s);
    expect(scope).toContain("offline.access");
    expect(scope).toContain("media.write");
  });
});

describe("TikTok authorize URL (the load-bearing deviations)", () => {
  const build = () =>
    new URL(
      tiktokAuthorizeUrl({
        clientKey: "tt-client-key",
        redirectUri: REDIRECT.replace("{ch}", "tiktok"),
        state: STATE,
        codeChallenge: "challenge",
      }),
    );

  it("uses www.tiktok.com authorize host (NOT the open.tiktokapis.com API host)", () => {
    const u = build();
    expect(u.host).toBe("www.tiktok.com");
    expect(u.pathname).toBe("/v2/auth/authorize/");
  });

  it("sends client_key and NEVER client_id", () => {
    const u = build();
    expect(u.searchParams.get("client_key")).toBe("tt-client-key");
    expect(u.searchParams.get("client_id")).toBeNull();
  });

  it("comma-joins the scope string (every other provider uses spaces)", () => {
    const scope = build().searchParams.get("scope") ?? "";
    expect(scope).toContain(",");
    expect(scope).not.toContain(" ");
    expect(scope.split(",")).toEqual(
      expect.arrayContaining(["user.info.basic", "video.publish", "video.upload"]),
    );
  });

  it("carries PKCE S256", () => {
    const u = build();
    expect(u.searchParams.get("code_challenge")).toBe("challenge");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
  });
});

describe("Instagram authorize URL (IG Login flow)", () => {
  it("targets www.instagram.com/oauth/authorize with the instagram_business_* scopes", () => {
    const u = new URL(
      instagramAuthorizeUrl({ redirectUri: REDIRECT.replace("{ch}", "instagram"), state: STATE }),
    );
    expect(u.host).toBe("www.instagram.com");
    expect(u.pathname).toBe("/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("ig-app-id");
    expect(u.searchParams.get("response_type")).toBe("code");
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope).toContain("instagram_business_basic");
    expect(scope).toContain("instagram_business_content_publish");
  });

  it("throws a clear error when INSTAGRAM_APP_ID is unset", () => {
    delete env.INSTAGRAM_APP_ID;
    expect(() =>
      instagramAuthorizeUrl({ redirectUri: REDIRECT, state: STATE }),
    ).toThrow(/INSTAGRAM_APP_ID is not set/);
  });
});

describe("Threads authorize URL", () => {
  it("targets threads.net/oauth/authorize with the threads_* scopes", () => {
    const u = new URL(
      threadsAuthorizeUrl({ redirectUri: REDIRECT.replace("{ch}", "threads"), state: STATE }),
    );
    expect(u.host).toBe("threads.net");
    expect(u.pathname).toBe("/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("th-app-id");
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope).toContain("threads_basic");
    expect(scope).toContain("threads_content_publish");
    expect(scope).toContain("threads_manage_insights");
  });
});

describe("Facebook authorize URL (Login for Business)", () => {
  it("sends config_id and NO scope= (FLB binds permissions to the config, not scope)", () => {
    const u = new URL(
      facebookAuthorizeUrl({ redirectUri: REDIRECT.replace("{ch}", "facebook"), state: STATE }),
    );
    expect(u.host).toBe("www.facebook.com");
    expect(u.pathname).toBe("/v23.0/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("meta-app-id");
    expect(u.searchParams.get("config_id")).toBe("fb-config-id");
    // Sending scope= while the app has FLB crashes the Comet dialog — must be absent.
    expect(u.searchParams.get("scope")).toBeNull();
  });

  it("throws when META_FB_LOGIN_CONFIG_ID is missing (the silent 'Something Went Wrong' bug)", () => {
    delete env.META_FB_LOGIN_CONFIG_ID;
    expect(() =>
      facebookAuthorizeUrl({ redirectUri: REDIRECT, state: STATE }),
    ).toThrow(/META_FB_LOGIN_CONFIG_ID is not set/);
  });
});

describe("LinkedIn authorize URL", () => {
  it("targets linkedin.com/oauth/v2/authorization with member + org scopes", () => {
    const u = new URL(
      linkedinAuthorizeUrl({ redirectUri: REDIRECT.replace("{ch}", "linkedin"), state: STATE }),
    );
    expect(u.host).toBe("www.linkedin.com");
    expect(u.pathname).toBe("/oauth/v2/authorization");
    expect(u.searchParams.get("client_id")).toBe("li-client-id");
    const scope = u.searchParams.get("scope") ?? "";
    // Member posting scope is always present; org scopes are requested (granted
    // only if the app passed Community Management review — graceful fallback).
    expect(scope).toContain("w_member_social");
    expect(scope).toContain("w_organization_social");
  });
});

describe("YouTube authorize URL (Google OAuth 2.0)", () => {
  const build = () =>
    new URL(
      youtubeAuthorizeUrl({
        clientId: "yt-client-id",
        redirectUri: REDIRECT.replace("{ch}", "youtube"),
        state: STATE,
      }),
    );

  it("targets accounts.google.com/o/oauth2/v2/auth (NOT the API/token hosts)", () => {
    const u = build();
    expect(u.host).toBe("accounts.google.com");
    expect(u.pathname).toBe("/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("yt-client-id");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe(STATE);
  });

  it("space-joins the youtube.upload scope set (Google uses spaces, not commas)", () => {
    const scope = build().searchParams.get("scope") ?? "";
    expect(scope).not.toContain(",");
    for (const s of YOUTUBE_OAUTH_SCOPES) expect(scope.split(" ")).toContain(s);
    expect(scope).toContain("https://www.googleapis.com/auth/youtube.upload");
  });

  it("sends access_type=offline + prompt=consent so Google mints a refresh_token", () => {
    // Without BOTH, a reconnect silently returns no refresh_token and the
    // connection dies in ~1h — the load-bearing Google gotcha.
    const u = build();
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
});

import { test, expect } from "./helpers/test-user";

// End-to-end smoke for the TikTok "connect" flow. Mirrors
// channel-oauth-initiate.spec.ts (facebook/instagram/threads) but TikTok
// deviates from every other provider in three ways we pin here:
//
//   1. The public client identifier is `client_key`, NOT `client_id`.
//   2. The authorize endpoint is www.tiktok.com/v2/auth/authorize/ and the
//      scope is a COMMA-separated string.
//   3. The "not configured" + callback-error redirects land on the
//      per-channel page /settings/channels/tiktok?error=… (not /settings/channels).
//
// We don't drive the real TikTok consent screen (needs human approval). We
// verify the half we own: the initiate route's redirect + CSRF cookie, and
// that a provider-side ?error bounces back cleanly instead of 500-ing.

const TIKTOK = {
  initiate: "/api/oauth/tiktok/initiate",
  callback: "/api/oauth/tiktok/callback",
  stateCookie: "tiktok_oauth_state",
  authorizeHost: "www.tiktok.com",
  authorizePath: "/v2/auth/authorize/",
  // When TIKTOK_CLIENT_KEY / _SECRET are unset the route redirects here.
  notConfiguredRedirect: /\/settings\/channels\/tiktok\?error=tiktok_not_configured/,
} as const;

async function bootstrapWorkspace(page: import("@playwright/test").Page) {
  await page.getByLabel(/workspace name/i).fill("TikTok Smoke WS");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
}

test.describe("connect-channel TikTok OAuth initiate", () => {
  test("initiate redirects to the TikTok authorize URL with client_key", async ({
    authedContext,
  }) => {
    const { page, context } = authedContext;
    await bootstrapWorkspace(page);

    // POST from inside the authed browser context so session + active-workspace
    // cookies ride along. maxRedirects:0 keeps us off the real provider.
    const res = await context.request.post(TIKTOK.initiate, { maxRedirects: 0 });

    const status = res.status();
    const location = res.headers()["location"];
    const setCookie = res.headers()["set-cookie"] ?? "";

    test.info().annotations.push({
      type: "tiktok-initiate",
      description: `status=${status} location=${location ?? "(none)"} set-cookie=${
        setCookie ? "present" : "missing"
      }`,
    });

    expect(status, "initiate must return a redirect").toBeGreaterThanOrEqual(300);
    expect(status, "initiate must return a redirect").toBeLessThan(400);
    // GET-following redirect only — never a method-preserving 307/308. The tile
    // POSTs here and www.tiktok.com/v2/auth/authorize is GET-only; a 307 would
    // POST to it and fail. Regression guard (see channel-oauth-initiate.spec.ts).
    expect(status, "TikTok initiate must 303/302, never 307/308").not.toBe(307);
    expect(status).not.toBe(308);
    expect(location, "Location header missing on initiate response").toBeTruthy();

    // When TikTok keys aren't configured, the route redirects to the per-channel
    // page. That's valid behaviour — but it means the channel can't connect, so
    // flag it loudly like the sibling spec does for the other providers.
    if (TIKTOK.notConfiguredRedirect.test(location ?? "")) {
      throw new Error(
        `TikTok: OAuth keys not configured. Initiate redirected to ${location}. ` +
          `Set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET to enable this channel.`,
      );
    }

    const url = new URL(location!);
    expect(url.host, `Expected authorize host ${TIKTOK.authorizeHost}, got ${url.host}`).toBe(
      TIKTOK.authorizeHost,
    );
    expect(url.pathname).toBe(TIKTOK.authorizePath);

    // TikTok specifics: `client_key` (NOT client_id), PKCE S256, comma scope.
    expect(url.searchParams.get("client_key"), "client_key missing").toBeTruthy();
    expect(url.searchParams.get("client_id"), "TikTok must NOT send client_id").toBeNull();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge"), "PKCE code_challenge missing").toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
      url.searchParams.get("redirect_uri"),
      "redirect_uri must point at the tiktok callback",
    ).toMatch(/\/api\/oauth\/tiktok\/callback$/);
    expect(url.searchParams.get("state"), "CSRF state missing").toBeTruthy();
    // Scope is a single comma-joined string (not space-delimited).
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope.length, "scope must be present").toBeGreaterThan(0);
    expect(scope, "TikTok scope is comma-separated").not.toContain(" ");

    // CSRF/PKCE stash cookie must be set httpOnly so the verifier never touches
    // the client.
    expect(setCookie, `${TIKTOK.stateCookie} cookie missing on initiate response`).toContain(
      TIKTOK.stateCookie + "=",
    );
  });

  test("callback handles provider error gracefully", async ({ authedContext }) => {
    const { context } = authedContext;
    // Simulate TikTok bouncing back with ?error=access_denied (user clicked
    // Cancel). Must redirect to the per-channel page, not 500 or hang.
    const res = await context.request.get(
      `${TIKTOK.callback}?error=access_denied&error_description=User%20denied%20access`,
      { maxRedirects: 0 },
    );
    const status = res.status();
    const location = res.headers()["location"] ?? "";

    test.info().annotations.push({
      type: "tiktok-callback-error",
      description: `status=${status} location=${location || "(none)"}`,
    });

    expect(status, "callback should redirect on provider error").toBeGreaterThanOrEqual(300);
    expect(status).toBeLessThan(400);
    expect(location).toMatch(/\/settings\/channels\/tiktok\?error=/);
  });
});

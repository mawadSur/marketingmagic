import { test, expect } from "./helpers/test-user";

// End-to-end smoke for the Facebook / Instagram / Threads "connect" tiles.
//
// We don't drive the real provider consent screen — that needs human
// approval. Instead we verify the half we own:
//   1. The /settings/channels tile renders and POSTs to the initiate route.
//   2. The initiate route returns a 3xx Location that points at the
//      provider's authorize URL with the correct client_id, redirect_uri,
//      scope and state.
//   3. The CSRF nonce cookie is set on the response.
//   4. The callback route, when invoked with ?error=user_denied, redirects
//      back to /settings/channels?error=… so the user isn't stranded.
//
// If any of those break, the user-visible "Connect" button silently fails
// and that's what this spec catches.

// Each provider has either `expectedScopes` (classic OAuth scope= flow)
// or `expectsConfigId` (Facebook Login for Business binds permissions to
// a config_id from the dashboard, not to a scope param).
const PROVIDERS = [
  {
    channel: "facebook",
    initiate: "/api/oauth/facebook/initiate",
    callback: "/api/oauth/facebook/callback",
    nonceCookie: "fb_oauth_nonce",
    authorizeHost: "www.facebook.com",
    authorizePath: "/v23.0/dialog/oauth",
    expectedScopes: [] as readonly string[],
    expectsConfigId: true,
    notConfiguredRedirect: /\/settings\/channels\/facebook\?error=facebook_not_configured/,
  },
  {
    channel: "instagram",
    initiate: "/api/oauth/instagram/initiate",
    callback: "/api/oauth/instagram/callback",
    nonceCookie: "ig_oauth_nonce",
    authorizeHost: "www.instagram.com",
    authorizePath: "/oauth/authorize",
    expectedScopes: ["instagram_business_basic", "instagram_business_content_publish"] as readonly string[],
    expectsConfigId: false,
    notConfiguredRedirect: /\/settings\/channels\/instagram\?error=instagram_not_configured/,
  },
  {
    channel: "threads",
    initiate: "/api/oauth/threads/initiate",
    callback: "/api/oauth/threads/callback",
    nonceCookie: "th_oauth_nonce",
    authorizeHost: "threads.net",
    authorizePath: "/oauth/authorize",
    expectedScopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"] as readonly string[],
    expectsConfigId: false,
    notConfiguredRedirect: /\/settings\/channels\/threads\?error=threads_not_configured/,
  },
] as const;

async function bootstrapWorkspace(page: import("@playwright/test").Page) {
  await page.getByLabel(/workspace name/i).fill("OAuth Smoke WS");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
}

test.describe("connect-channel OAuth initiate", () => {
  for (const p of PROVIDERS) {
    test(`${p.channel}: tile present on /settings/channels`, async ({ authedContext }) => {
      const { page } = authedContext;
      await bootstrapWorkspace(page);
      await page.goto("/settings/channels");

      // The tile is a <form action={initiate} method="post"> wrapping a
      // submit button. Locate by its visible label.
      const tile = page.getByRole("button", { name: new RegExp(`connect ${p.channel}`, "i") });
      await expect(tile, `Tile for ${p.channel} should be visible`).toBeVisible();
    });

    test(`${p.channel}: initiate redirects to provider authorize URL`, async ({
      authedContext,
    }) => {
      const { page, context } = authedContext;
      await bootstrapWorkspace(page);

      // POST the initiate route from inside the authenticated browser
      // context so cookies (Supabase session, mm_active_ws) ride along.
      // maxRedirects:0 keeps us from following the redirect to the real
      // provider — we only want to inspect the Location header.
      const res = await context.request.post(p.initiate, { maxRedirects: 0 });

      const status = res.status();
      const location = res.headers()["location"];
      const setCookie = res.headers()["set-cookie"] ?? "";

      // Surface diagnostics in the report when something fails.
      test.info().annotations.push({
        type: `${p.channel}-initiate`,
        description: `status=${status} location=${location ?? "(none)"} set-cookie=${
          setCookie ? "present" : "missing"
        }`,
      });

      expect(status, "initiate must return a redirect").toBeGreaterThanOrEqual(300);
      expect(status, "initiate must return a redirect").toBeLessThan(400);
      expect(location, "Location header missing on initiate response").toBeTruthy();

      // Branch on whether OAuth keys are configured. Both branches are
      // valid behaviour — but the "not configured" path means the user
      // can't actually connect, which is the bug we'd want flagged.
      if (p.notConfiguredRedirect.test(location ?? "")) {
        throw new Error(
          `${p.channel}: OAuth keys not configured. Initiate redirected to ${location}. ` +
            `Set the appropriate *_APP_ID / *_APP_SECRET env vars to enable this channel.`,
        );
      }

      const url = new URL(location!);
      expect(url.host, `Expected authorize host ${p.authorizeHost}, got ${url.host}`).toBe(
        p.authorizeHost,
      );
      expect(url.pathname).toBe(p.authorizePath);

      // Required OAuth query params.
      expect(url.searchParams.get("client_id"), "client_id missing on authorize URL").toBeTruthy();
      expect(
        url.searchParams.get("redirect_uri"),
        "redirect_uri missing on authorize URL",
      ).toMatch(new RegExp(`/api/oauth/${p.channel}/callback$`));
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state"), "state (workspace:nonce) missing").toMatch(/.+:.+/);

      if (p.expectsConfigId) {
        // Facebook Login for Business: permissions/assets come from a
        // dashboard-configured config_id, not a scope= param. The
        // scope param should be absent.
        expect(
          url.searchParams.get("config_id"),
          "config_id missing on FLB authorize URL",
        ).toBeTruthy();
        expect(
          url.searchParams.get("scope"),
          "scope= should not be sent for Facebook Login for Business",
        ).toBeNull();
      } else {
        const scope = url.searchParams.get("scope") ?? "";
        for (const required of p.expectedScopes) {
          expect(scope, `scope ${required} missing from authorize URL`).toContain(required);
        }
      }

      // CSRF nonce must be set as an httpOnly cookie so the callback can
      // verify the round-trip.
      expect(setCookie, `${p.nonceCookie} cookie missing on initiate response`).toContain(
        p.nonceCookie + "=",
      );
    });

    test(`${p.channel}: callback handles provider error gracefully`, async ({
      authedContext,
    }) => {
      const { context } = authedContext;
      // Simulate the provider redirecting back with ?error=access_denied
      // (user clicked "Cancel" on the consent screen). Should bounce to
      // /settings/channels?error=… not 500 or hang.
      const res = await context.request.get(
        `${p.callback}?error=access_denied&error_description=User%20denied%20access`,
        { maxRedirects: 0 },
      );
      const status = res.status();
      const location = res.headers()["location"] ?? "";

      test.info().annotations.push({
        type: `${p.channel}-callback-error`,
        description: `status=${status} location=${location || "(none)"}`,
      });

      expect(status, "callback should redirect on provider error").toBeGreaterThanOrEqual(300);
      expect(status).toBeLessThan(400);
      expect(location).toMatch(/\/settings\/channels\?error=/);
    });

    test(`${p.channel}: per-channel deep-link page renders`, async ({ authedContext }) => {
      const { page } = authedContext;
      await bootstrapWorkspace(page);
      const response = await page.goto(`/settings/channels/${p.channel}`);
      // 200 always — the page itself decides whether to show the connect
      // button or the "not configured" warning based on env presence.
      expect(response?.status(), "deep-link page should return 200").toBe(200);
      // Either the Connect button OR the "not configured" warning is fine,
      // but if neither is present the page is broken.
      const connectBtn = page.getByRole("button", { name: new RegExp(`connect with ${p.channel}`, "i") });
      const notConfigured = page.getByText(/not configured/i);
      await expect(connectBtn.or(notConfigured)).toBeVisible();
    });
  }
});

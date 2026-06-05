import { test, expect } from "./helpers/test-user";

// End-to-end smoke for the connect entry points NOT covered by
// channel-oauth-initiate.spec.ts (facebook/instagram/threads) or
// tiktok-oauth-initiate.spec.ts. This file pins the three remaining channels:
//
//   - X         — POST /api/oauth/x/initiate → x.com authorize (OAuth 2.0 PKCE).
//   - LinkedIn  — GET  /api/oauth/linkedin/initiate → linkedin.com authorize.
//   - Bluesky   — NO provider redirect at all: app-password paste form.
//
// As with the sibling specs we never drive the real consent screen (human
// approval). We verify the half we own: the initiate redirect's host + params
// + CSRF cookie, the graceful provider-error bounce, and (Bluesky) that the
// connect form renders its inputs.

async function bootstrapWorkspace(page: import("@playwright/test").Page) {
  await page.getByLabel(/workspace name/i).fill("Connect Smoke WS");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
}

// ─── X (OAuth 2.0 PKCE, POST initiate) ───────────────────────────────────────

test.describe("connect-channel X OAuth initiate", () => {
  const X = {
    initiate: "/api/oauth/x/initiate",
    callback: "/api/oauth/x/callback",
    stateCookie: "x_oauth_state",
    authorizeHost: "x.com",
    authorizePath: "/i/oauth2/authorize",
    notConfigured: /\/settings\/channels\/x\?error=x_not_configured/,
  };

  test("tile present on /settings/channels", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await page.goto("/settings/channels");
    await expect(
      page.getByRole("button", { name: /connect x/i }),
      "Connect X tile should be visible",
    ).toBeVisible();
  });

  test("initiate redirects to x.com authorize with PKCE", async ({ authedContext }) => {
    const { page, context } = authedContext;
    await bootstrapWorkspace(page);

    const res = await context.request.post(X.initiate, { maxRedirects: 0 });
    const status = res.status();
    const location = res.headers()["location"];
    const setCookie = res.headers()["set-cookie"] ?? "";

    test.info().annotations.push({
      type: "x-initiate",
      description: `status=${status} location=${location ?? "(none)"} set-cookie=${
        setCookie ? "present" : "missing"
      }`,
    });

    expect(status).toBeGreaterThanOrEqual(300);
    expect(status).toBeLessThan(400);
    // Must NOT be a method-preserving 307/308: the tile POSTs here, and the
    // provider authorize endpoints are GET-only — a 307 makes the browser POST
    // to x.com/i/oauth2/authorize, which renders "Page isn't available".
    // 303 (or 302) forces the follow-up to be a GET. Regression guard.
    expect(status, "initiate must 303/302 (GET-following), never 307/308").not.toBe(307);
    expect(status).not.toBe(308);
    expect(location, "Location header missing").toBeTruthy();

    if (X.notConfigured.test(location ?? "")) {
      throw new Error(
        `X: OAuth keys not configured. Initiate redirected to ${location}. ` +
          `Set X_CLIENT_ID / X_CLIENT_SECRET to enable this channel.`,
      );
    }

    const url = new URL(location!);
    // x.com, NOT twitter.com — login cookies live on x.com post-migration.
    expect(url.host, `Expected x.com, got ${url.host}`).toBe(X.authorizeHost);
    expect(url.pathname).toBe(X.authorizePath);
    expect(url.searchParams.get("client_id"), "client_id missing").toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge"), "PKCE challenge missing").toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state"), "CSRF state missing").toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/x\/callback$/);
    // offline.access is required for X to issue a refresh token.
    expect(url.searchParams.get("scope") ?? "", "offline.access scope missing").toContain(
      "offline.access",
    );
    expect(setCookie, `${X.stateCookie} cookie missing`).toContain(X.stateCookie + "=");
  });

  test("callback handles provider error gracefully", async ({ authedContext }) => {
    const { context } = authedContext;
    const res = await context.request.get(
      `${X.callback}?error=access_denied&error_description=User%20denied%20access`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    // X bounces provider errors to its per-channel page.
    expect(res.headers()["location"] ?? "").toMatch(/\/settings\/channels\/x\?error=/);
  });
});

// ─── LinkedIn (3-legged OAuth, GET initiate) ─────────────────────────────────

test.describe("connect-channel LinkedIn OAuth initiate", () => {
  const LI = {
    initiate: "/api/oauth/linkedin/initiate",
    callback: "/api/oauth/linkedin/callback",
    nonceCookie: "li_oauth_nonce",
    authorizeHost: "www.linkedin.com",
    authorizePath: "/oauth/v2/authorization",
    notConfigured: /\/settings\/channels\?error=linkedin_not_configured/,
  };

  test("tile present on /settings/channels", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await page.goto("/settings/channels");
    await expect(page.getByRole("button", { name: /connect linkedin/i })).toBeVisible();
  });

  // The /settings/channels tile submits a <form method="post">, so POST MUST
  // work or the button 405s (this regressed in prod — see the route comment).
  // We assert BOTH methods: POST is the real button; GET is the deep-link path.
  for (const method of ["post", "get"] as const) {
    test(`initiate (${method.toUpperCase()}) redirects to LinkedIn authorize with member scope`, async ({
      authedContext,
    }) => {
      const { page, context } = authedContext;
      await bootstrapWorkspace(page);

      const res =
        method === "post"
          ? await context.request.post(LI.initiate, { maxRedirects: 0 })
          : await context.request.get(LI.initiate, { maxRedirects: 0 });
    const status = res.status();
    const location = res.headers()["location"];
    const setCookie = res.headers()["set-cookie"] ?? "";

    test.info().annotations.push({
      type: "linkedin-initiate",
      description: `status=${status} location=${location ?? "(none)"} set-cookie=${
        setCookie ? "present" : "missing"
      }`,
    });

    expect(status).toBeGreaterThanOrEqual(300);
    expect(status).toBeLessThan(400);
    // GET-following redirect only — never a method-preserving 307/308 (see the
    // X test for the full rationale; LinkedIn's authorize endpoint is GET-only).
    expect(status, "initiate must 303/302 (GET-following), never 307/308").not.toBe(307);
    expect(status).not.toBe(308);
    expect(location, "Location header missing").toBeTruthy();

    if (LI.notConfigured.test(location ?? "")) {
      throw new Error(
        `LinkedIn: OAuth keys not configured. Initiate redirected to ${location}. ` +
          `Set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET to enable this channel.`,
      );
    }

    const url = new URL(location!);
    expect(url.host, `Expected www.linkedin.com, got ${url.host}`).toBe(LI.authorizeHost);
    expect(url.pathname).toBe(LI.authorizePath);
    expect(url.searchParams.get("client_id"), "client_id missing").toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    // state is workspaceId:nonce.
    expect(url.searchParams.get("state"), "state missing").toMatch(/.+:.+/);
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/linkedin\/callback$/);
    expect(url.searchParams.get("scope") ?? "", "w_member_social scope missing").toContain(
      "w_member_social",
    );
      expect(setCookie, `${LI.nonceCookie} cookie missing`).toContain(LI.nonceCookie + "=");
    });
  }

  test("callback handles provider error gracefully", async ({ authedContext }) => {
    const { context } = authedContext;
    const res = await context.request.get(
      `${LI.callback}?error=user_cancelled_login&error_description=cancelled`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    // LinkedIn bounces provider errors to the channels index.
    expect(res.headers()["location"] ?? "").toMatch(/\/settings\/channels\?error=/);
  });
});

// ─── Bluesky (app-password — NO OAuth redirect) ──────────────────────────────

test.describe("connect-channel Bluesky (app password)", () => {
  test("tile present on /settings/channels and links to the connect form", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await page.goto("/settings/channels");
    // Bluesky is a LINK (not a POST form) since it has no provider redirect.
    const tile = page.getByRole("link", { name: /connect bluesky/i });
    await expect(tile).toBeVisible();
  });

  test("connect form renders handle + app-password inputs", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    const response = await page.goto("/settings/channels/bluesky");
    expect(response?.status(), "bluesky connect page should return 200").toBe(200);

    // Both required fields + the submit button must be present, or the
    // user can't connect Bluesky at all.
    await expect(page.getByLabel(/handle/i)).toBeVisible();
    await expect(page.getByLabel(/app password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /connect bluesky/i })).toBeVisible();
  });
});

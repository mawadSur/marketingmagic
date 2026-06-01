import { test, expect, request as playwrightRequest } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Smoke for the GitHub-Actions-driven video poller route
// (/api/cron/poll-video-jobs). The route is auth-gated by Bearer CRON_SECRET
// (no Supabase session) and cleanly no-ops when MPT is unconfigured. We verify:
//
//   1. No / wrong secret → 401 (the route never runs against the DB).
//   2. Valid secret with MPT unset → 200 + { skipped: "mpt-not-configured" }.
//   3. The ?secret=<CRON_SECRET> query form is accepted as an alternative to
//      the Authorization header (the route honours both).
//
// These run without an authenticated browser context because the route only
// trusts the shared CRON_SECRET, exactly like the post-scheduled cron.

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const ROUTE = "/api/cron/poll-video-jobs";
const CRON_SECRET = process.env.CRON_SECRET;
const MPT_CONFIGURED = Boolean(process.env.MPT_BASE_URL && process.env.MPT_API_TOKEN);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3000}`;

test.describe("cron: poll-video-jobs auth + no-op", () => {
  test("returns 401 with no Authorization header", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.post(ROUTE);
      expect(res.status(), "missing secret must be rejected").toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: "unauthorized" });
    } finally {
      await ctx.dispose();
    }
  });

  test("returns 401 with a wrong bearer secret", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.post(ROUTE, {
        headers: { authorization: "Bearer definitely-not-the-secret" },
      });
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test("is reachable with the correct Bearer CRON_SECRET", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET not set in the test env");
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.post(ROUTE, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      // Authorized → NOT 401. Either the no-op (MPT unset) or a real poll.
      expect(res.status(), "authorized request must not be 401").not.toBe(401);
      expect(res.status(), "authorized request should succeed").toBe(200);

      const body = await res.json();
      test.info().annotations.push({
        type: "cron-response",
        description: JSON.stringify(body),
      });

      if (!MPT_CONFIGURED) {
        // The contract: a clean no-op when MPT is unwired, NOT a crash.
        expect(body).toMatchObject({ skipped: "mpt-not-configured", checked: 0, results: [] });
      } else {
        // MPT is wired up — the route walks processing jobs and returns a
        // checked count + per-job results array instead of the skip marker.
        expect(body).toHaveProperty("checked");
        expect(Array.isArray(body.results)).toBe(true);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("accepts the ?secret= query form as an alternative to the header", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET not set in the test env");
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.post(`${ROUTE}?secret=${encodeURIComponent(CRON_SECRET!)}`);
      expect(res.status(), "query-secret form must authorize").not.toBe(401);
      expect(res.status()).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });
});

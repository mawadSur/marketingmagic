import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { makeFakeService } from "./helpers/fake-supabase";
import { generateKey } from "@/lib/api/keys";

// ── Unit: withApiKey middleware (src/lib/api/middleware.ts) ───────────────────
// Proves the HTTP contract: missing key → 401, unknown → 401, wrong scope → 403,
// rate-limited → 429, valid → handler runs with a workspace-scoped api. Every
// response carries a request_id, and unknown errors map to 500 (no leak).

const liveKey = generateKey();
const fake = makeFakeService({
  api_keys: [
    { id: "k1", workspace_id: "ws-A", key_hash: liveKey.hash, scopes: ["posts:read"], revoked_at: null },
  ],
});
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

// Rate limiter: default allow; individual tests flip it to deny.
const rl = vi.fn(async () => ({ ok: true, limit: 120, remaining: 119, resetMs: 60_000 }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => rl(...(a as [])) }));

// Sentry capture spy — assert 500s are reported.
const capture = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: (...a: unknown[]) => capture(...(a as [])) }));

import { withApiKey } from "@/lib/api/middleware";

function req(headers?: Record<string, string>) {
  return new NextRequest("https://x.test/api/v1/posts", { headers });
}
const auth = { authorization: `Bearer ${liveKey.raw}` };

beforeEach(() => {
  rl.mockResolvedValue({ ok: true, limit: 120, remaining: 119, resetMs: 60_000 });
});
afterEach(() => vi.clearAllMocks());

describe("auth", () => {
  it("401 missing_api_key when no Authorization header", async () => {
    const h = withApiKey("posts:read")(async () => NextResponse.json({ ok: true }));
    const res = await h(req(), {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_api_key");
    expect(body.error.request_id).toMatch(/^req_/);
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("401 invalid_api_key for an unknown key", async () => {
    const h = withApiKey("posts:read")(async () => NextResponse.json({ ok: true }));
    const res = await h(req({ authorization: `Bearer ${generateKey().raw}` }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_api_key");
  });
});

describe("scope", () => {
  it("403 insufficient_scope when the key lacks the required scope", async () => {
    const h = withApiKey("posts:write")(async () => NextResponse.json({ ok: true }));
    const res = await h(req(auth), {});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_scope");
    expect(body.error.message).toContain("posts:write");
  });

  it("runs the handler when the key has the scope", async () => {
    const h = withApiKey("posts:read")(async (_r, { api }) =>
      NextResponse.json({ workspace: api.workspaceId }),
    );
    const res = await h(req(auth), {});
    expect(res.status).toBe(200);
    expect((await res.json()).workspace).toBe("ws-A");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("119");
  });
});

describe("rate limit", () => {
  it("429 rate_limited with Retry-After when over budget", async () => {
    rl.mockResolvedValue({ ok: false, limit: 120, remaining: 0, resetMs: 30_000 });
    const h = withApiKey("posts:read")(async () => NextResponse.json({ ok: true }));
    const res = await h(req(auth), {});
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

describe("error handling", () => {
  it("maps an unexpected throw to 500 internal_error and reports to Sentry", async () => {
    const h = withApiKey("posts:read")(async () => {
      throw new Error("kaboom");
    });
    const res = await h(req(auth), {});
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("kaboom"); // no internal leak
    expect(capture).toHaveBeenCalledOnce();
  });
});

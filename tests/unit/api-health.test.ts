import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── /api/health endpoint tests ────────────────────────────────────────────────
//
// Validates the health endpoint's shape and behavior: 200 when healthy, 503 when
// a critical dependency (Supabase, env vars) is missing. We mock Supabase and env
// so we can test both success and failure paths without a live DB.

// Mock env: required vars set by default (the healthy case).
const env: Record<string, string | undefined> = {};
function resetEnv() {
  for (const k of Object.keys(env)) delete env[k];
  env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  env.ANTHROPIC_API_KEY = "sk-ant-123";
  env.CRON_SECRET = "cron-secret-16-chars";
}

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
}));

// Mock Supabase service client. We'll override the from().select() chain to
// return success or error per test.
const mockSelect = vi.fn();
const mockLimit = vi.fn(() => ({ maybeSingle: vi.fn() }));
const mockFrom = vi.fn(() => ({
  select: mockSelect.mockReturnValue({ limit: mockLimit }),
}));

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: mockFrom }),
}));

// Import the route handler AFTER mocking.
import { GET } from "@/app/api/health/route";

beforeEach(() => {
  resetEnv();
  vi.clearAllMocks();
  // Default: DB query succeeds (healthy).
  mockLimit.mockReturnValue({
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
});

afterEach(() => vi.clearAllMocks());

describe("/api/health", () => {
  it("returns 200 {ok:true} when all checks pass", async () => {
    const req = new NextRequest("http://localhost:3000/api/health");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 503 when Supabase query fails", async () => {
    // Override the mock to return an error.
    mockLimit.mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "connection refused" },
      }),
    });

    const req = new NextRequest("http://localhost:3000/api/health");
    const resp = await GET();
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body).toEqual({ ok: false, error: "database_unreachable" });
  });

  it("returns 503 when ANTHROPIC_API_KEY is missing", async () => {
    delete env.ANTHROPIC_API_KEY;

    const req = new NextRequest("http://localhost:3000/api/health");
    const resp = await GET();
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body).toEqual({ ok: false, error: "missing_anthropic_key" });
  });

  it("returns 503 when CRON_SECRET is missing", async () => {
    delete env.CRON_SECRET;

    const req = new NextRequest("http://localhost:3000/api/health");
    const resp = await GET();
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body).toEqual({ ok: false, error: "missing_cron_secret" });
  });
});

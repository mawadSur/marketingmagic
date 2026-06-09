import { describe, expect, it, vi } from "vitest";

// ── Unit: Plan generation rate limiting (src/app/(app)/plans/new/actions.ts) ──
//
// Verifies that generatePlanAction correctly applies rate limiting per workspace
// before processing the plan. When the rate limit is exceeded, the action should
// return an error state without calling the expensive plan generation logic.

// Mock the rate-limit module to control the limit response
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// Mock workspace auth to return a fake workspace
vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceOrRedirect: vi.fn(async () => ({
    id: "test-ws-id",
    name: "Test Workspace",
    plan: "free",
  })),
}));

import { generatePlanAction } from "@/app/(app)/plans/new/actions";
import { checkRateLimit } from "@/lib/rate-limit";

describe("generatePlanAction rate limiting", () => {
  it("returns error when rate limit exceeded", async () => {
    // Mock rate limit exceeded (10 req/min on workspace)
    vi.mocked(checkRateLimit).mockResolvedValue({
      ok: false,
      limit: 10,
      remaining: 0,
      resetMs: 45000, // 45 seconds until reset
    });

    const formData = new FormData();
    formData.set("weeks", "1");
    formData.set("include_acc-123", "on");
    formData.set("posts_acc-123", "3");

    const result = await generatePlanAction({ error: null, planId: null }, formData);

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("generating plans too quickly");
    expect(result.error).toContain("1 minute"); // 45s rounds to 1 minute
    expect(result.planId).toBeNull();

    // Verify checkRateLimit was called with correct params
    expect(checkRateLimit).toHaveBeenCalledWith("plan-gen", "test-ws-id", 10, 60_000);
  });

  it("proceeds when rate limit allows", async () => {
    // Mock rate limit OK
    vi.mocked(checkRateLimit).mockResolvedValue({
      ok: true,
      limit: 10,
      remaining: 9,
      resetMs: 60000,
    });

    const formData = new FormData();
    formData.set("weeks", "1");
    // No channels selected → will fail validation, but AFTER rate limit check

    const result = await generatePlanAction({ error: null, planId: null }, formData);

    // Should get past rate limit and hit form validation error
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("generating plans too quickly");
    expect(result.error).toContain("Array must contain at least 1 element");

    // Rate limit was checked
    expect(checkRateLimit).toHaveBeenCalledWith("plan-gen", "test-ws-id", 10, 60_000);
  });
});

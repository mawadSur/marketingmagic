import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Unit: free-tier attribution (src/lib/growth/attribution.ts) ──────────────
//
// Two gates must both pass before the "Made with marketingmagic" line is
// appended: plan === 'hobby' (resolved via the entitlement resolver, which we
// mock) AND the workspace's attribution_enabled flag (read off the svc client
// we pass in). We dial each independently to prove the truth table, and check
// the pure appendAttributionLine transform is idempotent.

const planRef: { value: string } = { value: "hobby" };

vi.mock("@/lib/billing/entitlements", () => ({
  resolvePlanForWorkspace: () => Promise.resolve(planRef.value),
}));

import {
  attributionLine,
  appendAttributionLine,
  applyAttribution,
  shouldAppendAttribution,
} from "@/lib/growth/attribution";

// Minimal fake of the svc client: workspaces.select(...).eq(...).maybeSingle()
// resolves to a row carrying the attribution_enabled flag we set per-test.
function fakeSvc(attributionEnabled: boolean | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data:
                attributionEnabled === null
                  ? null
                  : { attribution_enabled: attributionEnabled },
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  planRef.value = "hobby";
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("shouldAppendAttribution: both gates must pass", () => {
  it("hobby + toggle on → append", async () => {
    planRef.value = "hobby";
    expect(await shouldAppendAttribution(fakeSvc(true), "ws")).toBe(true);
  });

  it("hobby + toggle off → no append", async () => {
    planRef.value = "hobby";
    expect(await shouldAppendAttribution(fakeSvc(false), "ws")).toBe(false);
  });

  it("paid plan ignores the toggle (pro + toggle on → no append)", async () => {
    planRef.value = "pro";
    expect(await shouldAppendAttribution(fakeSvc(true), "ws")).toBe(false);
  });

  it("org-inherited paid plan (agency) → no append", async () => {
    planRef.value = "agency";
    expect(await shouldAppendAttribution(fakeSvc(true), "ws")).toBe(false);
  });

  it("missing workspace row → defensive no append", async () => {
    planRef.value = "hobby";
    expect(await shouldAppendAttribution(fakeSvc(null), "ws")).toBe(false);
  });
});

describe("applyAttribution: returns text with/without the line", () => {
  it("appends the line on a qualifying hobby workspace", async () => {
    planRef.value = "hobby";
    const out = await applyAttribution(fakeSvc(true), "ws", "Hello world");
    expect(out).toBe(`Hello world\n\n${attributionLine()}`);
  });

  it("leaves text untouched when not qualifying", async () => {
    planRef.value = "pro";
    const out = await applyAttribution(fakeSvc(true), "ws", "Hello world");
    expect(out).toBe("Hello world");
  });
});

describe("appendAttributionLine: pure + idempotent", () => {
  it("appends a separated footer that includes the linked site URL", () => {
    const out = appendAttributionLine("post body");
    expect(out).toBe(`post body\n\n${attributionLine()}`);
    // The appended footer carries a clickable URL with the attribution ref so
    // the PLG loop actually mints leads (renders as plain text on socials).
    expect(out).toContain("?ref=post");
  });

  it("does not double-append when the line is already present", () => {
    const once = appendAttributionLine("post body");
    expect(appendAttributionLine(once)).toBe(once);
  });

  it("trims trailing whitespace before appending", () => {
    expect(appendAttributionLine("post body   \n")).toBe(`post body\n\n${attributionLine()}`);
  });
});

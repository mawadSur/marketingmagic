import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: shareable preview links (src/lib/growth/preview-share.ts +
//    src/app/preview/[token]/actions.ts) ───────────────────────────────────
//
// The security property under test is the SHARE-TOKEN READ SCOPE:
//   * a valid signed preview token mints a share row whose stored payload is
//     the PREVIEW CONTENT ONLY — never any account/workspace/user data
//   * an EXPIRED or TAMPERED token mints NOTHING (can't laundry a dead token
//     into a permanent share)
//   * getPreviewShare returns the payload for a live slug, and null for an
//     expired one (callers render not-found rather than leak existence)
//   * isValidShareSlug rejects malformed slugs before any DB touch

// Stable signing secret so signPreviewToken / verifyPreviewToken round-trip.
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "test-cron-secret-0123456789" }),
}));

// In-memory preview_shares table.
const store = {
  rows: [] as Array<{ slug: string; payload: unknown; expires_at: string | null }>,
  insert: vi.fn(),
};

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table !== "preview_shares") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: { slug: string; payload: unknown; expires_at: string | null }) => {
          store.insert(row);
          store.rows.push(row);
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: (_col: string, slug: string) => ({
            maybeSingle: () => {
              const found = store.rows.find((r) => r.slug === slug);
              return Promise.resolve({
                data: found ? { payload: found.payload, expires_at: found.expires_at } : null,
                error: null,
              });
            },
          }),
        }),
      };
    },
  }),
}));

// Silence the funnel analytics console line.
vi.mock("@/lib/preview/analytics", () => ({
  track: vi.fn(),
  hashHandle: (h: string) => h,
}));

import { signPreviewToken } from "@/lib/preview/token";
import {
  createPreviewShare,
  getPreviewShare,
  isValidShareSlug,
} from "@/lib/growth/preview-share";
import { createShareFromTokenAction } from "@/app/preview/[token]/actions";

const samplePayload = {
  channel: "x" as const,
  handle: "acme",
  plan: {
    plan_name: "Acme launch week",
    overview: "A week of build-in-public posts.",
    posts: [
      {
        channel: "x",
        text: "Day 1: we shipped.",
        theme: "launch",
        suggested_scheduled_at: new Date().toISOString(),
        rationale: "Opening hook.",
      },
    ],
  },
  voice_summary: "Voice profile extracted from 12 x posts.",
  source: "scrape" as const,
};

beforeEach(() => {
  store.rows = [];
  store.insert.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("isValidShareSlug", () => {
  it("accepts 8–40 url-safe chars, rejects the rest", () => {
    expect(isValidShareSlug("abcDEF12_-")).toBe(true);
    expect(isValidShareSlug("short")).toBe(false); // < 8
    expect(isValidShareSlug("has space here!!")).toBe(false);
    expect(isValidShareSlug(null)).toBe(false);
  });
});

describe("createPreviewShare / getPreviewShare", () => {
  it("persists the payload under a valid slug and reads it back", async () => {
    const slug = await createPreviewShare(samplePayload);
    expect(isValidShareSlug(slug)).toBe(true);
    const read = await getPreviewShare(slug);
    expect(read).toEqual(samplePayload);
  });

  it("stores ONLY preview content — no account/workspace/user keys", async () => {
    await createPreviewShare(samplePayload);
    const stored = store.insert.mock.calls[0]![0].payload as Record<string, unknown>;
    const keys = Object.keys(stored);
    // Allowlist exactly the preview fields; assert no account-shaped keys leaked.
    expect(keys.sort()).toEqual(
      ["channel", "handle", "niche_hint", "plan", "source", "voice_summary"].filter((k) =>
        k in stored,
      ),
    );
    for (const forbidden of ["workspace_id", "user_id", "owner_id", "email", "id"]) {
      expect(forbidden in stored).toBe(false);
    }
  });

  it("returns null for an expired slug (no existence leak)", async () => {
    // Hand-insert an already-expired row.
    store.rows.push({
      slug: "expiredexpired00",
      payload: samplePayload,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await getPreviewShare("expiredexpired00")).toBeNull();
  });

  it("returns null for an unknown / malformed slug", async () => {
    expect(await getPreviewShare("doesnotexist0000")).toBeNull();
    expect(await getPreviewShare("bad slug!")).toBeNull();
  });
});

describe("createShareFromTokenAction (share-token read scope)", () => {
  it("a valid token mints a share carrying only the preview content", async () => {
    const token = signPreviewToken(samplePayload);
    const res = await createShareFromTokenAction(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toMatch(/^\/p\/[a-zA-Z0-9_-]{8,40}$/);
      const read = await getPreviewShare(res.path.replace("/p/", ""));
      expect(read?.handle).toBe("acme");
    }
    expect(store.insert).toHaveBeenCalledTimes(1);
  });

  it("a tampered token mints NOTHING", async () => {
    const token = signPreviewToken(samplePayload);
    const tampered = token.slice(0, -3) + "xyz"; // corrupt the signature
    const res = await createShareFromTokenAction(tampered);
    expect(res.ok).toBe(false);
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("a malformed token mints NOTHING", async () => {
    const res = await createShareFromTokenAction("not-a-token");
    expect(res.ok).toBe(false);
    expect(store.insert).not.toHaveBeenCalled();
  });
});

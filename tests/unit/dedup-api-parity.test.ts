import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";
import { hashContent } from "@/lib/dedup/similarity";

// ── Unit: Public API createPost — dedup parity (src/lib/api/context.ts) ────────
//
// The wedge promise is "a workspace never re-posts the same content." The in-app
// generators already gate on dedup; this pins the SAME guarantee on the Public
// REST API insert-path: an exact/near repeat of recent or queued content is
// forced to pending_approval (never silently auto-published), content_hash is
// stamped on every insert (so the row is dedup-able later), and genuinely-new
// content still schedules. Uses the REAL dedup gate against the stateful fake so
// a drift in either the gate or the wiring is caught.

const { overLimit } = vi.hoisted(() => ({ overLimit: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/billing/limits", () => ({ overLimitAccountIds: overLimit }));

const DUP_TEXT = "Daily standup reminder — drop your update in the thread.";

const fake = makeFakeService({
  social_accounts: [
    { id: "acct-A", workspace_id: "ws-A", channel: "bluesky", handle: "a.bsky", status: "connected", trust_mode: false, successful_post_count: 0, created_at: "2026-01-01T00:00:00Z" },
  ],
  posts: [
    // A recent queued post whose text we'll re-submit. A far-future created_at
    // keeps it inside the gate's 45-day corpus window for any test run date.
    { id: "post-existing", workspace_id: "ws-A", channel: "bluesky", text: DUP_TEXT, status: "scheduled", content_hash: hashContent(DUP_TEXT), scheduled_at: "2099-01-01T00:00:00Z", posted_at: null, theme: null, media: [], created_at: "2099-01-01T00:00:00Z" },
  ],
});

vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

import { WorkspaceApi } from "@/lib/api/context";

beforeEach(() => {
  overLimit.mockResolvedValue(new Set<string>());
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("Public API createPost — dedup parity", () => {
  it("forces an exact repeat to pending_approval and stamps content_hash + match meta", async () => {
    const api = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    const created = await api.createPost({ channel: "bluesky", text: DUP_TEXT });

    // Never auto-publishes a duplicate via the API.
    expect(created.status).toBe("pending_approval");

    const row = fake._db.posts!.find((p) => p.id === created.id) as Record<string, unknown>;
    expect(row.content_hash).toBe(hashContent(DUP_TEXT));
    const meta = row.generation_metadata as Record<string, unknown>;
    expect(meta.source).toBe("public_api");
    expect(meta.dedup).toBeTruthy();
    expect((meta.dedup as Record<string, unknown>).match_id).toBe("post-existing");
  });

  it("lets genuinely-new content schedule and still stamps its content_hash", async () => {
    const api = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    const text = "Shipping a brand-new capability nobody has seen from us before.";
    const created = await api.createPost({ channel: "bluesky", text });

    expect(created.status).toBe("scheduled");
    const row = fake._db.posts!.find((p) => p.id === created.id) as Record<string, unknown>;
    expect(row.content_hash).toBe(hashContent(text));
    expect((row.generation_metadata as Record<string, unknown>).dedup).toBeUndefined();
  });
});

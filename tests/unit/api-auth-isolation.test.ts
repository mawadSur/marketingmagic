import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";

// ── Unit: PUBLIC-API TENANT ISOLATION (src/lib/api/context.ts) ────────────────
//
// THE most important test in the public-API surface. The API path uses the
// service-role client, which BYPASSES RLS — so workspace isolation lives entirely
// in WorkspaceApi, which must filter every query by workspace_id. These tests
// seed two workspaces' data into ONE shared fake DB and prove a WorkspaceApi
// bound to workspace A can never see or touch workspace B's rows.
//
// If someone deletes a `.eq("workspace_id", …)` in context.ts, one of these fails.

const { overLimit } = vi.hoisted(() => ({ overLimit: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/billing/limits", () => ({ overLimitAccountIds: overLimit }));

const fake = makeFakeService({
  social_accounts: [
    { id: "acct-A", workspace_id: "ws-A", channel: "bluesky", handle: "a.bsky", status: "connected", trust_mode: false, successful_post_count: 0, created_at: "2026-01-01T00:00:00Z" },
    { id: "acct-B", workspace_id: "ws-B", channel: "bluesky", handle: "b.bsky", status: "connected", trust_mode: false, successful_post_count: 0, created_at: "2026-01-01T00:00:00Z" },
  ],
  social_accounts_safe: [
    { id: "acct-A", workspace_id: "ws-A", channel: "bluesky", handle: "a.bsky", status: "connected", trust_mode: false, successful_post_count: 0, created_at: "2026-01-01T00:00:00Z" },
    { id: "acct-B", workspace_id: "ws-B", channel: "bluesky", handle: "b.bsky", status: "connected", trust_mode: false, successful_post_count: 0, created_at: "2026-01-01T00:00:00Z" },
  ],
  posts: [
    { id: "post-A", workspace_id: "ws-A", channel: "bluesky", text: "A's post", status: "scheduled", scheduled_at: "2026-09-01T00:00:00Z", posted_at: null, external_id: null, theme: null, media: [], created_at: "2026-02-01T00:00:00Z" },
    { id: "post-B", workspace_id: "ws-B", channel: "bluesky", text: "B's secret", status: "scheduled", scheduled_at: "2026-09-01T00:00:00Z", posted_at: null, external_id: null, theme: null, media: [], created_at: "2026-02-01T00:00:00Z" },
  ],
});

vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

import { WorkspaceApi } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";

beforeEach(() => {
  overLimit.mockResolvedValue(new Set<string>());
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("listChannels — scoped to the bound workspace", () => {
  it("A sees only A's channels", async () => {
    const apiA = new WorkspaceApi("ws-A", ["channels:read"], fake as never);
    const rows = await apiA.listChannels();
    expect(rows.map((r) => r.id)).toEqual(["acct-A"]);
  });
  it("B sees only B's channels", async () => {
    const apiB = new WorkspaceApi("ws-B", ["channels:read"], fake as never);
    const rows = await apiB.listChannels();
    expect(rows.map((r) => r.id)).toEqual(["acct-B"]);
  });
});

describe("listPosts — scoped to the bound workspace", () => {
  it("A never sees B's posts", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:read"], fake as never);
    const rows = await apiA.listPosts();
    expect(rows.map((r) => r.id)).toEqual(["post-A"]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
});

describe("getPost — cross-tenant id is a 404, not a leak", () => {
  it("A fetching B's post id throws not_found (never returns B's row)", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:read"], fake as never);
    await expect(apiA.getPost("post-B")).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<ApiError>);
  });
  it("A fetching its own post succeeds", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:read"], fake as never);
    const post = await apiA.getPost("post-A");
    expect(post.id).toBe("post-A");
  });
});

describe("createPost — cannot borrow another workspace's channel account", () => {
  it("A specifying B's social_account_id gets not_found and writes NOTHING", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    const before = fake._db.posts!.length;
    await expect(
      apiA.createPost({ channel: "bluesky", text: "hi", socialAccountId: "acct-B" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fake._db.posts!.length).toBe(before); // no insert happened
  });

  it("A scheduling on its OWN channel writes a post owned by ws-A", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    const created = await apiA.createPost({ channel: "bluesky", text: "hello world" });
    expect(created.status).toBe("scheduled");
    const row = fake._db.posts!.find((p) => p.id === created.id)!;
    expect(row.workspace_id).toBe("ws-A");
    expect(row.social_account_id).toBe("acct-A");
  });
});

describe("createPost — honours the plan channel cap", () => {
  it("throws channel_over_limit when the account is over the cap", async () => {
    overLimit.mockResolvedValue(new Set(["acct-A"]));
    const apiA = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    await expect(apiA.createPost({ channel: "bluesky", text: "hi" })).rejects.toMatchObject({
      code: "channel_over_limit",
    });
  });
});

describe("cancelPost — workspace-scoped", () => {
  it("A cannot cancel B's post (404 before any write)", async () => {
    const apiA = new WorkspaceApi("ws-A", ["posts:write"], fake as never);
    await expect(apiA.cancelPost("post-B")).rejects.toMatchObject({ code: "not_found" });
    // B's post is untouched.
    expect(fake._db.posts!.find((p) => p.id === "post-B")!.status).toBe("scheduled");
  });
});

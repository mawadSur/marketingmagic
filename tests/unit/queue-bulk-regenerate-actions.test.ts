import { beforeEach, describe, expect, it, vi } from "vitest";
import { briefContentFingerprint } from "@/lib/brand/fingerprint";

// ── Unit: queue/actions.ts — approveAllPendingAction + regenerateStalePendingAction
//
// approveAllPendingAction:
//   • approved=0 + no audit rows when the queue is empty (idempotent)
//   • flips every pending_approval row to scheduled; leaves scheduled rows alone
//   • inserts one approvals row per approved post
//   • surfaces a DB update error
//   • revalidates /queue
//
// regenerateStalePendingAction:
//   • errors when the workspace has no brand brief
//   • regenerated=0 when nothing is stale (fresh + legacy posts ignored)
//   • rewrites ONLY stale posts (stamped fingerprint != current) in place,
//     re-stamps the current fingerprint, and writes an 'edited' audit row
//   • a regeneration that throws is counted in `failed`, others still succeed
//   • caps the batch at 16 and reports `remaining`

const { mockWsId, mockUserId, state, regenerateMock, revalidatePath, makeClient } = vi.hoisted(
  () => {
    const mockWsId = "ws-regen-test";
    const mockUserId = "user-regen-1";
    const state = {
      brief: null as Record<string, unknown> | null,
      posts: [] as Array<Record<string, unknown>>,
      approvalInserts: [] as Array<Record<string, unknown>>,
      updateError: null as { message: string } | null,
    };

    type Filter = [string, unknown] | ["in", string, unknown[]];
    const applyFilters = (rows: Array<Record<string, unknown>>, filters: Filter[]) =>
      rows.filter((r) =>
        filters.every((f) =>
          f[0] === "in" ? (f[2] as unknown[]).includes(r[f[1] as string]) : r[f[0]] === f[1],
        ),
      );

    function makeClient() {
      return {
        from(table: string) {
          if (table === "brand_briefs") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: state.brief, error: null }),
                }),
              }),
            };
          }
          if (table === "posts") {
            return {
              select: () => {
                const filters: Filter[] = [];
                const chain: Record<string, unknown> = {};
                chain.eq = (c: string, v: unknown) => {
                  filters.push([c, v]);
                  return chain;
                };
                chain.in = (c: string, v: unknown[]) => {
                  filters.push(["in", c, v]);
                  return chain;
                };
                chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) => {
                  const data = applyFilters(state.posts, filters).map((r) => ({ ...r }));
                  return Promise.resolve({ data, error: null }).then(resolve);
                };
                return chain;
              },
              update: (payload: Record<string, unknown>) => {
                const filters: Filter[] = [];
                const apply = () => {
                  const matched = state.updateError ? [] : applyFilters(state.posts, filters);
                  for (const r of matched) Object.assign(r, payload);
                  return matched;
                };
                const chain: Record<string, unknown> = {};
                chain.eq = (c: string, v: unknown) => {
                  filters.push([c, v]);
                  return chain;
                };
                chain.in = (c: string, v: unknown[]) => {
                  filters.push(["in", c, v]);
                  return chain;
                };
                // Terminal await with NO .select() (approveAllPendingAction).
                chain.then = (resolve: (r: { error: { message: string } | null }) => unknown) => {
                  apply();
                  return Promise.resolve({ error: state.updateError }).then(resolve);
                };
                // Terminal .select() (regenerateStalePendingAction) — returns the
                // rows that actually matched the filters (incl. the status guard).
                chain.select = () => ({
                  then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
                    const matched = apply();
                    return Promise.resolve({
                      data: state.updateError ? null : matched.map((r) => ({ id: r.id })),
                      error: state.updateError,
                    }).then(resolve);
                  },
                });
                return chain;
              },
            };
          }
          if (table === "approvals") {
            return {
              insert: (rows: unknown) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                state.approvalInserts.push(...(arr as Array<Record<string, unknown>>));
                return Promise.resolve({ error: null });
              },
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    }

    return {
      mockWsId,
      mockUserId,
      state,
      regenerateMock: vi.fn(async () => ({
        text: "Rewritten to match the new brief.",
        voice_score: 88,
        rationale: "Aligned tone with the updated voice.",
      })),
      revalidatePath: vi.fn(),
      makeClient,
    };
  },
);

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceOrRedirect: vi.fn(async () => ({ id: mockWsId })),
  getAuthedUserOrRedirect: vi.fn(async () => ({ id: mockUserId })),
}));
vi.mock("@/lib/plan/regenerate-post", () => ({ regeneratePostForBrief: regenerateMock }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: vi.fn(async () => makeClient()) }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: vi.fn(() => makeClient()) }));

import {
  approveAllPendingAction,
  regenerateStalePendingAction,
} from "@/app/(app)/queue/actions";

const BRIEF = {
  product_description: "AI marketing copilot for solo founders.",
  voice: "Direct and witty.",
  target_audience: "Indie hackers.",
  do_not_say: ["synergy"],
  reference_links: [],
  reference_posts: ["Shipped today."],
  voice_profile: null,
};
const CURRENT_FP = briefContentFingerprint(BRIEF);
const OLD_FP = "0000000000000000";

function post(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: over.id,
    workspace_id: mockWsId,
    status: "pending_approval",
    text: "original",
    theme: "launch",
    channel: "x",
    generation_metadata: {},
    ...over,
  };
}

beforeEach(() => {
  state.brief = { ...BRIEF };
  state.posts = [];
  state.approvalInserts = [];
  state.updateError = null;
  vi.clearAllMocks();
});

// ── approveAllPendingAction ───────────────────────────────────────────────────
describe("approveAllPendingAction", () => {
  it("returns approved=0 and writes no audit rows when nothing is pending", async () => {
    state.posts = [post({ id: "p1", status: "scheduled" })];
    const r = await approveAllPendingAction();
    expect(r.error).toBeNull();
    expect(r.approved).toBe(0);
    expect(state.approvalInserts).toHaveLength(0);
  });

  it("flips every pending post to scheduled, leaving scheduled rows untouched", async () => {
    state.posts = [
      post({ id: "p1", status: "pending_approval" }),
      post({ id: "p2", status: "pending_approval" }),
      post({ id: "p3", status: "scheduled" }),
    ];
    const r = await approveAllPendingAction();
    expect(r.approved).toBe(2);
    expect(state.posts.find((p) => p.id === "p1")?.status).toBe("scheduled");
    expect(state.posts.find((p) => p.id === "p2")?.status).toBe("scheduled");
    expect(state.posts.find((p) => p.id === "p3")?.status).toBe("scheduled");
    expect(state.posts.find((p) => p.id === "p1")?.approved_at).toBeTruthy();
  });

  it("inserts one approvals row per approved post", async () => {
    state.posts = [
      post({ id: "p1" }),
      post({ id: "p2" }),
    ];
    await approveAllPendingAction();
    expect(state.approvalInserts).toHaveLength(2);
    expect(state.approvalInserts[0]).toMatchObject({ user_id: mockUserId, action: "approved" });
  });

  it("surfaces a DB update error", async () => {
    state.posts = [post({ id: "p1" })];
    state.updateError = { message: "deadlock detected" };
    const r = await approveAllPendingAction();
    expect(r.error).toBe("deadlock detected");
    expect(r.approved).toBe(0);
  });

  it("revalidates /queue on success", async () => {
    state.posts = [post({ id: "p1" })];
    await approveAllPendingAction();
    expect(revalidatePath).toHaveBeenCalledWith("/queue");
  });
});

// ── regenerateStalePendingAction ──────────────────────────────────────────────
describe("regenerateStalePendingAction", () => {
  it("errors when the workspace has no brand brief", async () => {
    state.brief = null;
    const r = await regenerateStalePendingAction();
    expect(r.error).toMatch(/brand brief/i);
    expect(r.regenerated).toBe(0);
  });

  it("regenerated=0 when nothing is stale (fresh + legacy posts ignored)", async () => {
    state.posts = [
      post({ id: "fresh", generation_metadata: { brief_fingerprint: CURRENT_FP } }),
      post({ id: "legacy", generation_metadata: { source: "compose" } }),
    ];
    const r = await regenerateStalePendingAction();
    expect(r.error).toBeNull();
    expect(r.regenerated).toBe(0);
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("rewrites only stale posts and re-stamps the current fingerprint", async () => {
    state.posts = [
      post({ id: "stale", generation_metadata: { brief_fingerprint: OLD_FP } }),
      post({ id: "fresh", generation_metadata: { brief_fingerprint: CURRENT_FP } }),
    ];
    const r = await regenerateStalePendingAction();
    expect(r.regenerated).toBe(1);
    expect(r.failed).toBe(0);
    expect(regenerateMock).toHaveBeenCalledTimes(1);
    const stale = state.posts.find((p) => p.id === "stale")!;
    expect(stale.text).toBe("Rewritten to match the new brief.");
    expect(stale.voice_score).toBe(88);
    expect(stale.status).toBe("pending_approval");
    expect((stale.generation_metadata as Record<string, unknown>).brief_fingerprint).toBe(
      CURRENT_FP,
    );
    // Fresh post left exactly as it was.
    expect(state.posts.find((p) => p.id === "fresh")?.text).toBe("original");
  });

  it("writes an 'edited' audit row per regenerated post", async () => {
    state.posts = [post({ id: "stale", generation_metadata: { brief_fingerprint: OLD_FP } })];
    await regenerateStalePendingAction();
    expect(state.approvalInserts).toHaveLength(1);
    expect(state.approvalInserts[0]).toMatchObject({
      post_id: "stale",
      user_id: mockUserId,
      action: "edited",
    });
  });

  it("counts a failed rewrite without aborting the rest of the batch", async () => {
    regenerateMock
      .mockRejectedValueOnce(new Error("API blip"))
      .mockResolvedValueOnce({ text: "ok", voice_score: 90, rationale: "fine" });
    state.posts = [
      post({ id: "s1", generation_metadata: { brief_fingerprint: OLD_FP } }),
      post({ id: "s2", generation_metadata: { brief_fingerprint: OLD_FP } }),
    ];
    const r = await regenerateStalePendingAction();
    expect(r.regenerated + r.failed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.regenerated).toBe(1);
  });

  it("does NOT regenerate a stale thread tweet (threads keep their own flow)", async () => {
    state.posts = [
      post({
        id: "thread-tweet",
        generation_metadata: {
          brief_fingerprint: OLD_FP,
          thread: { is_thread: true, tweet_index: 2, total_tweets: 3, role: "body" },
        },
      }),
    ];
    const r = await regenerateStalePendingAction();
    expect(r.regenerated).toBe(0);
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(state.posts.find((p) => p.id === "thread-tweet")?.text).toBe("original");
  });

  it("caps the batch at 8 and reports the remaining count", async () => {
    state.posts = Array.from({ length: 20 }, (_, i) =>
      post({ id: `s${i}`, generation_metadata: { brief_fingerprint: OLD_FP } }),
    );
    const r = await regenerateStalePendingAction();
    expect(r.regenerated).toBe(8);
    expect(r.remaining).toBe(12);
    expect(regenerateMock).toHaveBeenCalledTimes(8);
  });

  it("skips (does not revert/overwrite) a draft approved mid-regen — status guard", async () => {
    state.posts = [post({ id: "racey", generation_metadata: { brief_fingerprint: OLD_FP } })];
    // Simulate a concurrent "Approve" landing while the Opus call runs: the row
    // leaves pending_approval between our SELECT and our UPDATE.
    regenerateMock.mockImplementationOnce(async () => {
      state.posts.find((p) => p.id === "racey")!.status = "scheduled";
      return { text: "rewrite", voice_score: 90, rationale: "x" };
    });
    const r = await regenerateStalePendingAction();
    expect(r.regenerated).toBe(0);
    expect(r.failed).toBe(0);
    const racey = state.posts.find((p) => p.id === "racey")!;
    expect(racey.status).toBe("scheduled"); // approval NOT reverted
    expect(racey.text).toBe("original"); // body NOT overwritten
    expect(state.approvalInserts).toHaveLength(0); // no spurious audit row
  });

  it("marks a low voice_score regeneration as low_confidence when a profile is set", async () => {
    state.brief = { ...BRIEF, voice_profile: { formality: "casual", summary: "x" } };
    regenerateMock.mockResolvedValueOnce({ text: "weak", voice_score: 40, rationale: "off" });
    const currentFpWithProfile = briefContentFingerprint(
      state.brief as Parameters<typeof briefContentFingerprint>[0],
    );
    state.posts = [
      post({ id: "stale", generation_metadata: { brief_fingerprint: "stale-fp-differs" } }),
    ];
    // sanity: the post must actually be stale vs the profile-bearing fingerprint
    expect(currentFpWithProfile).not.toBe("stale-fp-differs");
    await regenerateStalePendingAction();
    expect(state.posts.find((p) => p.id === "stale")?.low_confidence).toBe(true);
  });
});

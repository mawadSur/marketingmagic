import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit: variation lineage on insert (Hormozi slice #4, migration 060) ──────
//
// Proves the persistence contract: when runVariationGeneration() saves the
// matrix as draft posts, EVERY draft carries
//   • parent_post_id     = the source post id
//   • variation_group_id = ONE shared uuid for the whole batch
// and the drafts land in pending_approval.
//
// Isolated in its own file (not variations.test.ts) because it mocks
// @/lib/variations/generate — and vi.mock is file-global, so the generator
// test must NOT see that stub.

const insertSpy = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: () => ({
      // Migration 067 idempotency read: runVariationGeneration first pulls the
      // existing content_hash set for this parent's prior variation rows. No
      // priors exist in this test, so resolve an empty list — all 4 variations
      // are new and get inserted.
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
      insert: (payload: unknown[]) => {
        insertSpy(payload);
        return {
          select: () => ({
            // Echo back one {id} per inserted row so the count check passes.
            then: (resolve: (v: { data: { id: string }[]; error: null }) => unknown) =>
              resolve({
                data: (payload as unknown[]).map((_, i) => ({ id: `inserted-${i}` })),
                error: null,
              }),
          }),
        };
      },
      delete: () => ({ in: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) }),
    }),
  }),
}));

vi.mock("@/lib/variations/generate", () => ({
  generateVariationMatrix: vi.fn(),
}));

import { runVariationGeneration } from "@/lib/variations/run";
import { generateVariationMatrix as genMock } from "@/lib/variations/generate";

describe("runVariationGeneration — lineage on insert", () => {
  beforeEach(() => {
    insertSpy.mockReset();
    // 4 assembled variations is enough to prove the lineage contract.
    const variations = [0, 1, 2, 3].map((i) => ({
      hook: { spoken: `h${i}`, visual: `v${i}` },
      body: { spoken: `b${i}`, cta_overlay: `c${i}` },
      hook_index: i,
      body_index: 0,
      full_text: `[ON-SCREEN: v${i}]\nh${i}\n\nb${i}\n\n[CTA OVERLAY: c${i}]`,
    }));
    (genMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      matrix: { overview: "o", hooks: [], bodies: [] },
      variations,
      hookCount: 4,
      bodyCount: 1,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  });

  it("stamps every draft with parent_post_id + one shared variation_group_id", async () => {
    const result = await runVariationGeneration({
      workspaceId: "ws-1",
      sourcePost: {
        id: "source-post-1",
        text: "Source clip that worked.",
        channel: "instagram",
        theme: "pricing-mistakes",
        social_account_id: "acct-1",
        workspace_id: "ws-1",
      },
      brief: null,
    });

    expect(result.created).toBe(4);
    expect(result.variationGroupId).toMatch(/[0-9a-f-]{36}/);

    // The single insert payload.
    expect(insertSpy).toHaveBeenCalledOnce();
    const payload = insertSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(4);

    // Every row: parent_post_id = the source id, status pending_approval,
    // and the SAME variation_group_id (the batch tag).
    const groupIds = new Set<string>();
    for (const row of payload) {
      expect(row.parent_post_id).toBe("source-post-1");
      expect(row.status).toBe("pending_approval");
      expect(row.social_account_id).toBe("acct-1");
      expect(row.channel).toBe("instagram");
      groupIds.add(row.variation_group_id as string);
    }
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBe(result.variationGroupId);
  });

  it("rejects a source post with empty text before generating", async () => {
    await expect(
      runVariationGeneration({
        workspaceId: "ws-1",
        sourcePost: {
          id: "source-post-1",
          text: "   ",
          channel: "instagram",
          theme: null,
          social_account_id: "acct-1",
          workspace_id: "ws-1",
        },
        brief: null,
      }),
    ).rejects.toThrow(/no text/i);
  });
});

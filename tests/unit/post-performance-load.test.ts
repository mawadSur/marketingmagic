import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit: loadWorkspacePerformance — the one DB read + scoring map (T1.2). ────
//
// We mock supabaseService() so the query chain
//   from("posts").select(...).eq(...).eq(...).gte(...)
// resolves a canned { data } payload (mirrors the chain-mock style in
// tests/unit/variations.test.ts / client-account-isolation.test.ts). The
// builder is thenable, so the chain resolves whatever depth the caller walks.
//
// Covers:
//   - returns a Map keyed by postId, scored against the full-workspace corpus
//   - opts.postIds filters the RETURNED ids (corpus stays the whole workspace)
//   - an insufficient / empty corpus -> empty map

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: fromMock }),
}));

import { loadWorkspacePerformance } from "@/lib/feedback/post-performance";

// A thenable query builder: every chain method returns the builder; awaiting
// it resolves the configured result. Matches Supabase's PostgREST builder,
// which is itself a thenable.
function builderResolving(result: { data: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ["select", "eq", "gte", "lte", "in", "order", "limit"]) {
    builder[m] = vi.fn(passthrough);
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve);
  return builder;
}

// A posts row with a single post_metrics snapshot, posted `daysAgo` days back.
function row(
  id: string,
  rate: number | null,
  saves: number | null,
  daysAgo: number,
) {
  const posted = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    id,
    posted_at: posted,
    post_metrics: [{ engagement_rate: rate, saves, fetched_at: posted }],
  };
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("loadWorkspacePerformance", () => {
  it("returns a Map keyed by postId with verdicts scored vs the corpus", async () => {
    // Baseline corpus: a cluster of ~0.05 posts + one clear winner. All old
    // enough to be past the 48h age gate (10 days back).
    const data = [
      row("p1", 0.05, null, 10),
      row("p2", 0.05, null, 11),
      row("p3", 0.05, null, 12),
      row("p4", 0.05, null, 13),
      row("p5", 0.05, null, 14),
      row("win", 0.12, 80, 9), // ~2.4x baseline -> winner
      row("lose", 0.01, null, 8), // ~0.2x baseline -> underperformer
    ];
    fromMock.mockReturnValue(builderResolving({ data }));

    const map = await loadWorkspacePerformance("ws-1");

    expect(map).toBeInstanceOf(Map);
    // Every row with a posted_at appears, keyed by its id.
    expect(map.size).toBe(7);
    expect(map.has("win")).toBe(true);
    expect(map.get("win")!.postId).toBe("win");
    expect(map.get("win")!.verdict).toBe("winner");
    expect(map.get("lose")!.verdict).toBe("underperformer");
    expect(map.get("p1")!.verdict).toBe("average");
  });

  it("opts.postIds filters the returned ids but keeps the full corpus", async () => {
    const data = [
      row("p1", 0.05, null, 10),
      row("p2", 0.05, null, 11),
      row("p3", 0.05, null, 12),
      row("p4", 0.05, null, 13),
      row("p5", 0.05, null, 14),
      row("win", 0.12, null, 9),
    ];
    fromMock.mockReturnValue(builderResolving({ data }));

    const map = await loadWorkspacePerformance("ws-1", { postIds: ["win"] });

    // Only the requested id is RETURNED ...
    expect(map.size).toBe(1);
    expect(map.has("win")).toBe(true);
    // ... but it was judged against the full corpus (baseline ~0.05), so it's
    // still a winner — proving the corpus wasn't narrowed to just ["win"].
    const win = map.get("win")!;
    expect(win.baseline).toBeCloseTo(0.05, 6);
    expect(win.verdict).toBe("winner");
    expect(win.ratio!).toBeGreaterThan(2);
  });

  it("an empty corpus yields an empty map", async () => {
    fromMock.mockReturnValue(builderResolving({ data: [] }));
    const map = await loadWorkspacePerformance("ws-1");
    expect(map.size).toBe(0);
  });

  it("a query error yields an empty map", async () => {
    fromMock.mockReturnValue(builderResolving({ data: null, error: { message: "boom" } }));
    const map = await loadWorkspacePerformance("ws-1");
    expect(map.size).toBe(0);
  });

  it("posts with no metric snapshot are scored pending (no corpus contribution)", async () => {
    // p_nometric has a null engagement_rate -> it's not in the corpus AND it
    // scores pending. The two real posts form the (tiny) corpus.
    const data = [
      row("a", 0.05, null, 10),
      row("b", 0.06, null, 11),
      { id: "p_nometric", posted_at: new Date(Date.now() - 10 * 86400000).toISOString(), post_metrics: [] },
    ];
    fromMock.mockReturnValue(builderResolving({ data }));

    const map = await loadWorkspacePerformance("ws-1");
    expect(map.size).toBe(3);
    expect(map.get("p_nometric")!.verdict).toBe("pending");
    expect(map.get("p_nometric")!.score).toBeNull();
  });
});

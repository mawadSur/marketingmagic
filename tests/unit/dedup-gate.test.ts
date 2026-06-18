import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit: dedupePosts + loadRecentCorpus — the dedup gate's I/O half (T2.1). ──
//
// We mock supabaseService() so the query chain
//   from("posts").select(...).eq(...).in(...).gt(...).order(...).limit(...)
// resolves a canned { data } payload. The builder is a thenable that records
// every chain call's arguments (mirrors the chain-mock style in
// tests/unit/post-performance-load.test.ts / variations.test.ts), so we can
// both feed it a corpus AND assert the WHERE clause the gate actually sent.
//
// Covers:
//   - exact corpus match (same caption, different trailing link) -> "exact"
//     pointing at the prior post's id
//   - paraphrase of a corpus post -> "near" with score >= NEAR_DUP_THRESHOLD
//   - genuinely different content -> "ok"
//   - intra-batch: two identical candidates -> first "ok", second "exact"
//   - the query filters status in ('posted','scheduled','pending_approval') AND
//     applies a created_at lower bound — so a QUEUED, never-posted dup is caught

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: fromMock }),
}));

import { loadRecentCorpus, dedupePosts } from "@/lib/dedup/gate";
import { hashContent, NEAR_DUP_THRESHOLD } from "@/lib/dedup/similarity";

// A thenable query builder that records the arguments of every chain method, so
// a test can inspect what filters were applied. Each method returns the builder
// (so any chain depth works); awaiting resolves the configured result.
function builderResolving(result: { data: unknown; error?: unknown }) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return builder;
    });
  for (const m of ["select", "eq", "in", "gt", "gte", "lt", "lte", "order", "limit"]) {
    builder[m] = record(m);
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve);
  builder.__calls = calls;
  return builder as Record<string, unknown> & { __calls: Record<string, unknown[][]> };
}

// A corpus posts row. status defaults to the queued state so the tests exercise
// the "un-posted dup is still caught" path; content_hash is precomputed (as the
// real column would be) unless explicitly nulled to test the recompute path.
function row(
  id: string,
  text: string,
  status: string = "scheduled",
  contentHash: string | null | undefined = undefined,
) {
  return {
    id,
    text,
    theme: null,
    status,
    content_hash: contentHash === undefined ? hashContent(text) : contentHash,
  };
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("loadRecentCorpus", () => {
  it("filters status in the active set and applies a created_at lower bound", async () => {
    const b = builderResolving({ data: [row("p1", "hello world from a corpus post here")] });
    fromMock.mockReturnValue(b);

    const corpus = await loadRecentCorpus("ws-1");
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.id).toBe("p1");

    // Queried the posts table, scoped to the workspace.
    expect(fromMock).toHaveBeenCalledWith("posts");
    expect(b.__calls.eq).toContainEqual(["workspace_id", "ws-1"]);

    // status in ('posted','scheduled','pending_approval') — a queued, un-posted
    // dup MUST be in scope.
    const inCall = b.__calls.in?.[0];
    expect(inCall?.[0]).toBe("status");
    const statuses = inCall?.[1] as string[];
    expect(statuses).toContain("posted");
    expect(statuses).toContain("scheduled");
    expect(statuses).toContain("pending_approval");

    // created_at lower bound (a real ISO timestamp in the recent past).
    const gtCall = b.__calls.gt?.[0];
    expect(gtCall?.[0]).toBe("created_at");
    const lowerBound = gtCall?.[1] as string;
    expect(Date.parse(lowerBound)).toBeLessThan(Date.now());
    expect(Date.parse(lowerBound)).toBeGreaterThan(0);
  });

  it("returns [] on a query error (fail-open)", async () => {
    fromMock.mockReturnValue(builderResolving({ data: null, error: { message: "boom" } }));
    expect(await loadRecentCorpus("ws-1")).toEqual([]);
  });
});

describe("dedupePosts", () => {
  it("flags an exact corpus match (same caption, different trailing link)", async () => {
    fromMock.mockReturnValue(
      builderResolving({
        data: [row("queued-1", "Big news today: we just shipped dark mode. Try it now!")],
      }),
    );

    // Same words, only a trailing share link differs — normalises identically,
    // so the content hash collides. The corpus row is merely SCHEDULED (never
    // posted), proving a queued dup is caught.
    const results = await dedupePosts("ws-1", [
      {
        text: "Big news today: we just shipped dark mode. Try it now! https://mm.co/x",
        channel: "x",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.verdict).toBe("exact");
    expect(results[0]!.match?.existingId).toBe("queued-1");
    expect(results[0]!.match?.kind).toBe("exact");
  });

  it("flags a paraphrase as near with score >= NEAR_DUP_THRESHOLD", async () => {
    const original =
      "Here is the one budgeting tip that completely changed how I run my small business every single month";
    fromMock.mockReturnValue(builderResolving({ data: [row("queued-2", original)] }));

    // Heavy overlap of 3-word runs with the original (a light reword), so
    // trigram Jaccard clears the near threshold but isn't an exact hash match.
    const paraphrase =
      "Here is the one budgeting tip that completely changed how I run my small business every month";

    const results = await dedupePosts("ws-1", [{ text: paraphrase, channel: "instagram" }]);

    expect(results[0]!.verdict).toBe("near");
    expect(results[0]!.match?.existingId).toBe("queued-2");
    expect(results[0]!.match?.kind).toBe("near");
    expect(results[0]!.match!.score).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
  });

  it("passes genuinely distinct content as ok", async () => {
    fromMock.mockReturnValue(
      builderResolving({
        data: [row("queued-3", "Five hiring mistakes that quietly killed our first startup team")],
      }),
    );

    const results = await dedupePosts("ws-1", [
      { text: "A short thread on why cold outreach still beats paid ads for early stage", channel: "linkedin" },
    ]);

    expect(results[0]!.verdict).toBe("ok");
    expect(results[0]!.match).toBeUndefined();
  });

  it("catches an intra-batch duplicate: first ok, second exact", async () => {
    // Empty corpus — the only thing the second candidate can match is the first.
    fromMock.mockReturnValue(builderResolving({ data: [] }));

    const text = "Three lessons from a year of building marketingmagic completely in public";
    const results = await dedupePosts("ws-1", [
      { text, channel: "x" },
      { text, channel: "instagram" }, // same words, different channel — still a dup
    ]);

    expect(results[0]!.verdict).toBe("ok");
    expect(results[1]!.verdict).toBe("exact");
    // The match points back at the first batch item (synthetic candidate id),
    // and is flagged intraBatch so consumers don't treat it as a real posts.id.
    expect(results[1]!.match?.existingId).toBe("candidate:0");
    expect(results[1]!.match?.kind).toBe("exact");
    expect(results[1]!.match?.intraBatch).toBe(true);
  });

  it("does not flag a corpus (real posts.id) match as intraBatch", async () => {
    // A genuine prior post — existingId is a real id, so intraBatch must be
    // false (or absent), never true.
    fromMock.mockReturnValue(
      builderResolving({
        data: [row("queued-9", "Big news today: we just shipped dark mode. Try it now!")],
      }),
    );

    const results = await dedupePosts("ws-1", [
      { text: "Big news today: we just shipped dark mode. Try it now!", channel: "x" },
    ]);

    expect(results[0]!.verdict).toBe("exact");
    expect(results[0]!.match?.existingId).toBe("queued-9");
    expect(results[0]!.match?.intraBatch).toBe(false);
  });

  it("recomputes a hash for corpus rows missing content_hash", async () => {
    // Pre-migration row with a null content_hash — exact match must still work
    // off the recomputed-from-text hash.
    fromMock.mockReturnValue(
      builderResolving({
        data: [row("legacy-1", "Our launch retro: what worked, what flopped, and the numbers", "posted", null)],
      }),
    );

    const results = await dedupePosts("ws-1", [
      { text: "Our launch retro: what worked, what flopped, and the numbers", channel: "x" },
    ]);

    expect(results[0]!.verdict).toBe("exact");
    expect(results[0]!.match?.existingId).toBe("legacy-1");
  });

  it("returns [] for an empty candidate batch without querying", async () => {
    const results = await dedupePosts("ws-1", []);
    expect(results).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("fail-SAFE: a corpus read error flags every candidate as near (manual review)", async () => {
    // Force a genuine corpus READ FAILURE (error set, no data).
    fromMock.mockReturnValue(builderResolving({ data: null, error: { message: "boom" } }));

    const results = await dedupePosts(
      "ws-1",
      [
        { text: "An entirely fresh, never-before-posted angle on shipping fast", channel: "x" },
        { text: "A second, also totally distinct caption about pricing experiments", channel: "linkedin" },
      ],
      { failSafe: true },
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.verdict).toBe("near"); // routes the caller to pending_approval
      expect(r.match?.kind).toBe("near");
      // Placeholder match: empty existingId (never a real posts.id), not intra-batch.
      expect(r.match?.existingId).toBe("");
      expect(r.match?.intraBatch).toBe(false);
      expect(r.match?.existingText).toContain("dedup temporarily unavailable");
    }
  });

  it("fail-OPEN (default): a corpus read error passes every candidate as ok", async () => {
    // Same read failure, but without failSafe — preserve the legacy fail-open
    // behavior (treat as empty corpus → all ok).
    fromMock.mockReturnValue(builderResolving({ data: null, error: { message: "boom" } }));

    const resultsDefault = await dedupePosts("ws-1", [
      { text: "An entirely fresh, never-before-posted angle on shipping fast", channel: "x" },
      { text: "A second, also totally distinct caption about pricing experiments", channel: "linkedin" },
    ]);
    const resultsExplicit = await dedupePosts(
      "ws-1",
      [{ text: "Yet another genuinely unique post about onboarding flows", channel: "x" }],
      { failSafe: false },
    );

    for (const r of resultsDefault) {
      expect(r.verdict).toBe("ok");
      expect(r.match).toBeUndefined();
    }
    expect(resultsExplicit[0]!.verdict).toBe("ok");
    expect(resultsExplicit[0]!.match).toBeUndefined();
  });
});

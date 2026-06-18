import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit: collectPostExemplars — the planner's "study the shape of what
// won/flopped" projection (Phase 8 dedup wedge). ─────────────────────────────
//
// collectPostExemplars sits on top of two boundaries:
//   1. loadWorkspacePerformance — the scoring layer (verdict + ratio per post)
//   2. supabaseService — the tiny extra read for post text + theme
// We mock BOTH so we can pin the exact verdicts/ratios and the exact text rows
// the collector sees, and prove the ranking + fallback + over-fetch behaviour
// in isolation (no DB, no scorer math).
//
// Covers the contract this collector owns:
//   - winners are highest-ratio first, losers lowest-ratio first
//   - STRONG FALLBACK: when there are < EXEMPLARS_PER_SIDE true 'winner' posts,
//     'strong' posts back-fill the winners side (highest ratio first) and are
//     surfaced under the 'winner' label — but losers stay strict (no fabrication)
//   - OVER-FETCH: a picked post whose text won't load back-fills with the
//     next-best candidate rather than shrinking the surfaced count
//   - exemplar text is verbatim (not whitespace-normalised) and capped at 200
//   - empty perf / query error -> []

const { loadPerfMock } = vi.hoisted(() => ({ loadPerfMock: vi.fn() }));
const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/feedback/post-performance", () => ({
  loadWorkspacePerformance: loadPerfMock,
}));
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: fromMock }),
}));

import { collectPostExemplars } from "@/lib/plan/signals";
import type { PostPerformance, PostVerdict } from "@/lib/feedback/post-performance";

// A minimal PostPerformance — only the fields collectPostExemplars reads
// (postId, verdict, ratio) need to be meaningful; the rest are filler.
function perf(postId: string, verdict: PostVerdict, ratio: number | null): PostPerformance {
  return {
    postId,
    engagementRate: ratio,
    saves: null,
    baseline: 1,
    ratio,
    percentile: null,
    verdict,
    score: null,
  };
}

function perfMap(...entries: PostPerformance[]): Map<string, PostPerformance> {
  const m = new Map<string, PostPerformance>();
  for (const e of entries) m.set(e.postId, e);
  return m;
}

// A thenable query builder whose terminal `.in(...)` resolves the canned text
// rows. Mirrors the builder mock in post-performance-load.test.ts.
function textBuilder(rows: Array<{ id: string; text: string | null; theme: string | null }>) {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ["select", "eq", "in"]) builder[m] = vi.fn(passthrough);
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return builder;
}

function errorBuilder() {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ["select", "eq", "in"]) builder[m] = vi.fn(passthrough);
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
  return builder;
}

function textRow(id: string, text: string | null, theme: string | null = null) {
  return { id, text, theme };
}

beforeEach(() => {
  loadPerfMock.mockReset();
  fromMock.mockReset();
});

describe("collectPostExemplars", () => {
  it("ranks winners highest-ratio first and losers lowest-ratio first", async () => {
    loadPerfMock.mockResolvedValue(
      perfMap(
        perf("w1", "winner", 2.0),
        perf("w2", "winner", 3.0),
        perf("l1", "underperformer", 0.4),
        perf("l2", "underperformer", 0.2),
      ),
    );
    fromMock.mockReturnValue(
      textBuilder([
        textRow("w1", "winner one", "a"),
        textRow("w2", "winner two", "b"),
        textRow("l1", "loser one", "c"),
        textRow("l2", "loser two", "d"),
      ]),
    );

    const out = await collectPostExemplars("ws-1");

    // winners-then-losers; winners by descending ratio, losers by ascending.
    expect(out.map((e) => e.text)).toEqual([
      "winner two", // ratio 3.0
      "winner one", // ratio 2.0
      "loser two", // ratio 0.2
      "loser one", // ratio 0.4
    ]);
    expect(out.filter((e) => e.verdict === "winner")).toHaveLength(2);
    expect(out.filter((e) => e.verdict === "underperformer")).toHaveLength(2);
  });

  it("STRONG FALLBACK: back-fills the winners side with 'strong' posts (as 'winner') when true winners are scarce", async () => {
    // Only ONE true winner, but two 'strong' posts. The winners side should
    // fill to EXEMPLARS_PER_SIDE (3): the winner first, then strong by ratio.
    loadPerfMock.mockResolvedValue(
      perfMap(
        perf("win", "winner", 2.5),
        perf("s_lo", "strong", 1.2),
        perf("s_hi", "strong", 1.4),
        perf("avg", "average", 1.0), // never picked
        perf("lose", "underperformer", 0.3),
      ),
    );
    fromMock.mockReturnValue(
      textBuilder([
        textRow("win", "real winner"),
        textRow("s_hi", "strong higher"),
        textRow("s_lo", "strong lower"),
        textRow("lose", "the flop"),
      ]),
    );

    const out = await collectPostExemplars("ws-1");

    const winners = out.filter((e) => e.verdict === "winner");
    // true winner first, then strong by descending ratio — all labelled 'winner'.
    expect(winners.map((e) => e.text)).toEqual([
      "real winner",
      "strong higher",
      "strong lower",
    ]);
    // 'average' is never surfaced.
    expect(out.some((e) => e.text === "the flop")).toBe(true);
    expect(out.filter((e) => e.verdict === "underperformer")).toHaveLength(1);
  });

  it("does NOT fabricate losers from non-underperformers (loser side stays strict)", async () => {
    // No underperformers at all — even with plenty of strong posts, the loser
    // side must stay empty (strong only ever feeds the WINNERS side).
    loadPerfMock.mockResolvedValue(
      perfMap(
        perf("s1", "strong", 1.3),
        perf("s2", "strong", 1.2),
        perf("avg", "average", 0.9),
      ),
    );
    fromMock.mockReturnValue(
      textBuilder([textRow("s1", "strong a"), textRow("s2", "strong b")]),
    );

    const out = await collectPostExemplars("ws-1");

    expect(out.filter((e) => e.verdict === "underperformer")).toHaveLength(0);
    // The two strong posts are surfaced as winners (the fallback pool).
    expect(out.filter((e) => e.verdict === "winner")).toHaveLength(2);
  });

  it("OVER-FETCH: a winner with no loadable text back-fills with the next-best rather than shrinking the count", async () => {
    // Four winners ranked w4>w3>w2>w1. The top two (w4, w3) have NO text row,
    // so the surfaced winners must back-fill to w2, w1 — still 3 winners (the
    // per-side cap), not 1.
    loadPerfMock.mockResolvedValue(
      perfMap(
        perf("w1", "winner", 1.6),
        perf("w2", "winner", 1.8),
        perf("w3", "winner", 2.2),
        perf("w4", "winner", 3.0),
        perf("lose", "underperformer", 0.3),
      ),
    );
    fromMock.mockReturnValue(
      textBuilder([
        // w4 and w3 deliberately absent / null-text -> dropped.
        textRow("w4", null),
        textRow("w2", "kept winner two"),
        textRow("w1", "kept winner one"),
        textRow("lose", "the flop"),
      ]),
    );

    const out = await collectPostExemplars("ws-1");

    const winners = out.filter((e) => e.verdict === "winner");
    // Back-filled to the next-best two that DO have text — count not shrunk to 1.
    expect(winners.map((e) => e.text)).toEqual(["kept winner two", "kept winner one"]);
    expect(out.some((e) => e.text === "the flop")).toBe(true);
  });

  it("keeps exemplar text verbatim (no whitespace normalisation) and caps at 200 chars", async () => {
    const messy = "  hooky\n   line\t  break  ";
    const long = "x".repeat(300);
    loadPerfMock.mockResolvedValue(
      perfMap(
        perf("w", "winner", 2.0),
        perf("lng", "winner", 1.9),
      ),
    );
    fromMock.mockReturnValue(
      textBuilder([textRow("w", messy), textRow("lng", long)]),
    );

    const out = await collectPostExemplars("ws-1");

    // Verbatim — newline/tab/multiple spaces preserved (the prompt renderer
    // sanitizes at the boundary, not here).
    const messyOut = out.find((e) => e.text.includes("hooky"))!;
    expect(messyOut.text).toBe(messy);
    // 200-char cap.
    const longOut = out.find((e) => e.text.startsWith("x"))!;
    expect(longOut.text.length).toBe(200);
    expect(longOut.text).toBe("x".repeat(200));
  });

  it("returns [] when there are no winners/losers to surface", async () => {
    loadPerfMock.mockResolvedValue(
      perfMap(perf("a", "average", 1.0), perf("p", "pending", null)),
    );

    const out = await collectPostExemplars("ws-1");
    expect(out).toEqual([]);
    // No text read should have been issued — nothing was picked.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns [] when the text read errors", async () => {
    loadPerfMock.mockResolvedValue(perfMap(perf("w", "winner", 2.0)));
    fromMock.mockReturnValue(errorBuilder());

    const out = await collectPostExemplars("ws-1");
    expect(out).toEqual([]);
  });
});

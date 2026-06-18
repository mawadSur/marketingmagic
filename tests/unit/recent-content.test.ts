import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Unit: collectRecentContent — the planner's "what's already in the queue"
// projection (Phase 8 dedup wedge). ──────────────────────────────────────────
//
// collectRecentContent is a thin projection over loadRecentCorpus (the dedup
// gate's recent+queued corpus loader, which itself reads supabaseService). The
// data boundary this collector owns is loadRecentCorpus, so we mock THAT seam:
// it lets us pin the exact rows the projection sees without standing up the gate
// query chain, and proves the mapping in isolation.
//
// Covers the contract:
//   - snippet is whitespace-collapsed, single-line, and clamped to ≤140 chars
//   - order is preserved newest-first (loadRecentCorpus returns created_at desc)
//   - the list is capped to 24 (default) and to an explicit `cap`
//   - an empty corpus yields []

const { loadRecentCorpusMock } = vi.hoisted(() => ({
  loadRecentCorpusMock: vi.fn(),
}));

vi.mock("@/lib/dedup/gate", () => ({
  loadRecentCorpus: loadRecentCorpusMock,
}));

import { collectRecentContent } from "@/lib/plan/recent-content";

// A RecentPost row as loadRecentCorpus returns it.
function post(
  id: string,
  text: string,
  theme: string | null,
  status: string,
) {
  return { id, text, theme, status, content_hash: null };
}

beforeEach(() => {
  loadRecentCorpusMock.mockReset();
});

describe("collectRecentContent", () => {
  it("collapses whitespace to a single line and clamps the snippet to 140 chars", async () => {
    const long = "a".repeat(300);
    loadRecentCorpusMock.mockResolvedValue([
      post("p1", "  multi\n   line\t  text  ", "budgeting", "posted"),
      post("p2", long, "hiring", "scheduled"),
    ]);

    const out = await collectRecentContent("ws-1");

    expect(out[0]!.snippet).toBe("multi line text");
    expect(out[0]!.snippet).not.toMatch(/[\n\t]/);
    expect(out[1]!.snippet.length).toBe(140);
    expect(out[1]!.snippet).toBe("a".repeat(140));
  });

  it("preserves loadRecentCorpus order (newest-first) and keeps theme + status", async () => {
    loadRecentCorpusMock.mockResolvedValue([
      post("newest", "freshest post", "launch", "pending_approval"),
      post("middle", "older post", null, "scheduled"),
      post("oldest", "oldest post", "recap", "posted"),
    ]);

    const out = await collectRecentContent("ws-1");

    expect(out.map((s) => s.snippet)).toEqual([
      "freshest post",
      "older post",
      "oldest post",
    ]);
    expect(out[0]!.status).toBe("pending_approval");
    expect(out[0]!.theme).toBe("launch");
    // Untagged posts keep a null theme (the prompt block buckets them itself).
    expect(out[1]!.theme).toBeNull();
  });

  it("caps the result to 24 by default", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      post(`p${i}`, `post number ${i}`, "theme", "posted"),
    );
    loadRecentCorpusMock.mockResolvedValue(rows);

    const out = await collectRecentContent("ws-1");
    expect(out).toHaveLength(24);
    // First 24, in order.
    expect(out[0]!.snippet).toBe("post number 0");
    expect(out[23]!.snippet).toBe("post number 23");
  });

  it("honours an explicit cap override", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      post(`p${i}`, `post ${i}`, "theme", "posted"),
    );
    loadRecentCorpusMock.mockResolvedValue(rows);

    const out = await collectRecentContent("ws-1", { cap: 3 });
    expect(out).toHaveLength(3);
  });

  it("drops rows whose status is outside the prompt union", async () => {
    loadRecentCorpusMock.mockResolvedValue([
      post("p1", "kept", "t", "posted"),
      post("p2", "dropped", "t", "draft"),
      post("p3", "kept too", "t", "scheduled"),
    ]);

    const out = await collectRecentContent("ws-1");
    expect(out.map((s) => s.snippet)).toEqual(["kept", "kept too"]);
  });

  it("returns [] when there is nothing recent", async () => {
    loadRecentCorpusMock.mockResolvedValue([]);
    const out = await collectRecentContent("ws-empty");
    expect(out).toEqual([]);
  });

  it("forwards the days option to loadRecentCorpus", async () => {
    loadRecentCorpusMock.mockResolvedValue([]);
    await collectRecentContent("ws-1", { days: 7 });
    expect(loadRecentCorpusMock).toHaveBeenCalledWith("ws-1", 7);
  });
});

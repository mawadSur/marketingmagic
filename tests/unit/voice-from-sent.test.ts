import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  foldSentExemplars,
  loadSentExemplars,
  MAX_SENT_EXEMPLARS,
  MAX_EXEMPLAR_CHARS,
  MIN_EXEMPLAR_CHARS,
  type SentExemplar,
} from "@/lib/voice/from-sent";

// ── TODO #0 (gap 2) — LEARN VOICE FROM THE USER'S OWN SENT/PUBLISHED TEXT ────
//
// The folding logic decides which genuine-voice samples reach the evolution
// prompt: it must drop noise (too-short, dupes), clamp long-form, sort newest-
// first, and cap volume. loadSentExemplars must pull from BOTH sources
// (published posts + manually-sent replies) and exclude AI auto-sent text.

describe("foldSentExemplars — pure folding", () => {
  it("drops too-short noise (single-word 'thanks!')", () => {
    const out = foldSentExemplars([
      { text: "ty", source: "published_post", at: "2026-06-01T00:00:00Z" },
      { text: "This is a real, substantial post worth keeping.", source: "published_post", at: "2026-06-02T00:00:00Z" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].text).toContain("substantial");
  });

  it("dedupes near-identical reposts", () => {
    const dup = "Shipping a big update today — here is what changed and why.";
    const out = foldSentExemplars([
      { text: dup, source: "published_post", at: "2026-06-01T00:00:00Z" },
      { text: dup, source: "sent_reply", at: "2026-06-02T00:00:00Z" },
    ]);
    expect(out.length).toBe(1);
  });

  it("clamps long-form to MAX_EXEMPLAR_CHARS", () => {
    const long = "a".repeat(MAX_EXEMPLAR_CHARS + 500);
    const out = foldSentExemplars([
      { text: long, source: "published_post", at: "2026-06-01T00:00:00Z" },
    ]);
    expect(out[0].text.length).toBe(MAX_EXEMPLAR_CHARS);
  });

  it("sorts newest-first", () => {
    const out = foldSentExemplars([
      { text: "older post about our roadmap and plans", source: "published_post", at: "2026-06-01T00:00:00Z" },
      { text: "newer post about a feature we just shipped", source: "published_post", at: "2026-06-05T00:00:00Z" },
    ]);
    expect(out[0].text).toContain("newer");
    expect(out[1].text).toContain("older");
  });

  it("caps at MAX_SENT_EXEMPLARS", () => {
    const many: SentExemplar[] = Array.from({ length: MAX_SENT_EXEMPLARS + 20 }, (_, i) => ({
      text: `Distinct genuine post number ${i} with enough length to keep.`,
      source: "published_post" as const,
      at: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    expect(foldSentExemplars(many).length).toBe(MAX_SENT_EXEMPLARS);
  });

  it("MIN_EXEMPLAR_CHARS boundary is respected", () => {
    const exact = "x".repeat(MIN_EXEMPLAR_CHARS); // exactly the floor → kept
    const below = "y".repeat(MIN_EXEMPLAR_CHARS - 1); // below → dropped
    const out = foldSentExemplars([
      { text: exact, source: "published_post", at: "2026-06-01T00:00:00Z" },
      { text: below, source: "published_post", at: "2026-06-02T00:00:00Z" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].text.startsWith("x")).toBe(true);
  });
});

// ── loadSentExemplars — pulls from both sources, excludes AI auto-sends ──────

// A query-recording fake: posts.status='posted' returns one human post;
// approvals (action='approved', user_id not null) returns one human-sent reply.
// The AI auto-reply path writes NO approvals row, so it never appears here —
// which is exactly what we assert by only seeding the two human sources.
function fakeSvc(opts: {
  posts: Array<{ text: string; posted_at: string }>;
  approvals: Array<{ created_at: string; user_id: string | null; posts: { text: string } }>;
}) {
  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {};
    const ret = () => c;
    c.select = ret;
    c.eq = ret;
    c.gte = ret;
    c.not = ret;
    c.order = ret;
    c.limit = () => Promise.resolve({ data: rows });
    return c;
  }
  const svc = {
    from(table: string) {
      if (table === "posts") return chain(opts.posts);
      if (table === "approvals") return chain(opts.approvals);
      throw new Error(`fakeSvc: unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return svc;
}

describe("loadSentExemplars — both sources", () => {
  it("merges published posts AND manually-sent replies", async () => {
    const svc = fakeSvc({
      posts: [
        { text: "We just shipped multi-timezone scheduling — here is the why.", posted_at: "2026-06-05T00:00:00Z" },
      ],
      approvals: [
        {
          created_at: "2026-06-06T00:00:00Z",
          user_id: "user-1",
          posts: { text: "Thanks for the kind words — more channel support is coming next." },
        },
      ],
    });
    const out = await loadSentExemplars(svc, "ws-1", "2026-06-01T00:00:00Z");
    expect(out.length).toBe(2);
    const sources = out.map((e) => e.source).sort();
    expect(sources).toEqual(["published_post", "sent_reply"]);
  });

  it("returns [] when there is no genuine sent text", async () => {
    const svc = fakeSvc({ posts: [], approvals: [] });
    const out = await loadSentExemplars(svc, "ws-1", "2026-06-01T00:00:00Z");
    expect(out).toEqual([]);
  });
});

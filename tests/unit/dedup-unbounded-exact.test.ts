import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";
import { hashContent } from "@/lib/dedup/similarity";

// ── Unit: dedupePosts unbounded exact-hash check (src/lib/dedup/gate.ts) ───────
//
// The near-dup scan is bounded to a recent window (DEFAULT_DAYS) for cost, which
// used to let a VERBATIM repeat of an older evergreen post auto-publish. The
// unbounded exact-hash lookup closes that: an exact content_hash collision is a
// re-post at ANY age. The fake honours .gt()/.in(), so the OLD post is excluded
// from the windowed corpus but found by the unbounded check — exactly the gap.

const OLD_TEXT = "Our evergreen origin story: how two founders started in a garage back in 2019.";

const fake = makeFakeService({
  posts: [
    // Posted ~6 years ago — far OUTSIDE the recent near-dup window, but it carries
    // a content_hash and an active ('posted') status, so an exact repeat is caught.
    {
      id: "old-evergreen",
      workspace_id: "ws-1",
      channel: "x",
      text: OLD_TEXT,
      status: "posted",
      content_hash: hashContent(OLD_TEXT),
      theme: null,
      created_at: "2020-01-01T00:00:00Z",
    },
  ],
});

vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

import { dedupePosts } from "@/lib/dedup/gate";

afterEach(() => {
  vi.clearAllMocks();
});

describe("dedupePosts — unbounded exact check beyond the recent window", () => {
  it("flags a verbatim repeat of an out-of-window post as exact", async () => {
    const results = await dedupePosts("ws-1", [{ text: OLD_TEXT, channel: "x" }]);
    expect(results[0]!.verdict).toBe("exact");
    expect(results[0]!.match?.kind).toBe("exact");
    expect(results[0]!.match?.existingId).toBe("old-evergreen");
  });

  it("still passes genuinely new content as ok", async () => {
    const results = await dedupePosts("ws-1", [
      { text: "A brand new announcement that shares nothing with anything we posted.", channel: "x" },
    ]);
    expect(results[0]!.verdict).toBe("ok");
    expect(results[0]!.match).toBeUndefined();
  });
});

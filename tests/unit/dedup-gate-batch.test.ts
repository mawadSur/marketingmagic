import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";
import { hashContent } from "@/lib/dedup/similarity";

// ── Unit: gateBatchForDedup — the shared batch insert-path gate ───────────────
//
// sources/[id], sources/build-in-public and voice-memo/persist all route their
// generated batch through gateBatchForDedup() right before insert. This pins the
// guarantee the wedge depends on: a duplicate is forced from 'scheduled' down to
// 'pending_approval' (never auto-published), every row is stamped with a
// content_hash, the match rides along in generation_metadata.dedup, and
// auto_scheduled is re-derived — while genuinely-new content stays scheduled.

const DUP = "Weekly changelog: shipped dark mode, fixed 12 bugs, faster cold loads.";

const fake = makeFakeService({
  posts: [
    // A recent queued post (far-future created_at keeps it in the 45-day window)
    // whose text one candidate will exactly repeat.
    { id: "existing", workspace_id: "ws-1", channel: "x", text: DUP, status: "scheduled", content_hash: hashContent(DUP), theme: null, created_at: "2099-01-01T00:00:00Z" },
  ],
});

vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

import { gateBatchForDedup } from "@/lib/dedup/gate";

afterEach(() => {
  vi.clearAllMocks();
});

describe("gateBatchForDedup", () => {
  it("downgrades a duplicate to pending_approval and leaves new content scheduled", async () => {
    const NEW = "A completely fresh announcement we have never posted before now.";
    const gated = (await gateBatchForDedup("ws-1", [
      { text: DUP, channel: "x", status: "scheduled", low_confidence: false, generation_metadata: { auto_scheduled: true } },
      { text: NEW, channel: "x", status: "scheduled", low_confidence: false, generation_metadata: { auto_scheduled: true } },
    ])) as Array<Record<string, unknown>>;

    // Duplicate → forced to review, flagged, hashed, tagged with the match.
    expect(gated[0]!.status).toBe("pending_approval");
    expect(gated[0]!.low_confidence).toBe(true);
    expect(gated[0]!.content_hash).toBe(hashContent(DUP));
    const meta0 = gated[0]!.generation_metadata as Record<string, unknown>;
    expect(meta0.auto_scheduled).toBe(false);
    expect((meta0.dedup as Record<string, unknown>).match_id).toBe("existing");

    // Genuinely new → stays scheduled, still hashed, no dedup tag.
    expect(gated[1]!.status).toBe("scheduled");
    expect(gated[1]!.content_hash).toBe(hashContent(NEW));
    const meta1 = gated[1]!.generation_metadata as Record<string, unknown>;
    expect(meta1.auto_scheduled).toBe(true);
    expect(meta1.dedup).toBeUndefined();
  });

  it("is a no-op shape-wise for an empty batch", async () => {
    const gated = await gateBatchForDedup("ws-1", []);
    expect(gated).toEqual([]);
  });
});

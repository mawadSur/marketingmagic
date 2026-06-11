import { describe, it, expect } from "vitest";

// ── Unit: approval-queue grouping (src/app/(app)/queue/queue-grouping.ts) ────
//
// Pins down which rows collapse into a group and which stay standalone:
//   • idea_id            → cross-channel idea (X-thread special case)
//   • variation_group_id → "30 filmable variations" batch (Hormozi slice #4)
//   • neither            → standalone single
// Plus the singleton-degrades-to-single rule for both group kinds, and the
// scheduled_at sort order.

import { groupQueueRows, type QueueDisplayRow } from "@/app/(app)/queue/queue-grouping";

// Minimal row factory — only the fields grouping reads matter; the rest are
// filled with inert defaults so the QueueDisplayRow shape is satisfied.
function row(overrides: Partial<QueueDisplayRow> & { id: string }): QueueDisplayRow {
  return {
    id: overrides.id,
    text: overrides.text ?? "draft text",
    theme: overrides.theme ?? null,
    scheduled_at: overrides.scheduled_at ?? null,
    status: overrides.status ?? "pending_approval",
    channel: overrides.channel ?? "instagram",
    media: overrides.media ?? [],
    image_prompt: overrides.image_prompt ?? null,
    mediaPublicUrl: overrides.mediaPublicUrl ?? null,
    voice_score: overrides.voice_score ?? null,
    low_confidence: overrides.low_confidence ?? false,
    idea_id: overrides.idea_id ?? null,
    external_id: overrides.external_id ?? null,
    failure_reason: overrides.failure_reason ?? null,
    generation_metadata: overrides.generation_metadata ?? null,
    tags: overrides.tags ?? [],
    experiment_status: overrides.experiment_status ?? null,
    variation_group_id: overrides.variation_group_id ?? null,
  };
}

describe("groupQueueRows — variation batches (Hormozi slice #4)", () => {
  it("collapses rows sharing a variation_group_id into ONE variation group", () => {
    const rows = [
      row({ id: "v1", variation_group_id: "batch-A" }),
      row({ id: "v2", variation_group_id: "batch-A" }),
      row({ id: "v3", variation_group_id: "batch-A" }),
    ];
    const groups = groupQueueRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("variation");
    if (groups[0].kind === "variation") {
      expect(groups[0].groupId).toBe("batch-A");
      expect(groups[0].variations.map((v) => v.id)).toEqual(["v1", "v2", "v3"]);
    }
  });

  it("keeps two distinct batches as two separate variation groups", () => {
    const rows = [
      row({ id: "a1", variation_group_id: "A" }),
      row({ id: "a2", variation_group_id: "A" }),
      row({ id: "b1", variation_group_id: "B" }),
      row({ id: "b2", variation_group_id: "B" }),
    ];
    const groups = groupQueueRows(rows);
    expect(groups.filter((g) => g.kind === "variation")).toHaveLength(2);
  });

  it("degrades a single surviving variation to a plain row (no batch header)", () => {
    // The other 29 were approved/rejected away; one lone draft left.
    const groups = groupQueueRows([row({ id: "lonely", variation_group_id: "batch-A" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
  });

  it("does NOT merge a variation batch with unrelated standalone drafts", () => {
    const rows = [
      row({ id: "v1", variation_group_id: "batch-A" }),
      row({ id: "v2", variation_group_id: "batch-A" }),
      row({ id: "loose" }), // no idea_id, no variation_group_id
    ];
    const groups = groupQueueRows(rows);
    expect(groups.filter((g) => g.kind === "variation")).toHaveLength(1);
    expect(groups.filter((g) => g.kind === "single")).toHaveLength(1);
  });
});

describe("groupQueueRows — precedence + existing behavior", () => {
  it("idea_id wins: a row with both idea_id and variation_group_id groups by idea", () => {
    // Defensive — the variation runner never sets idea_id, but the bucketing
    // must be deterministic if it ever did.
    const rows = [
      row({ id: "i1", idea_id: "idea-1", variation_group_id: "batch-A" }),
      row({ id: "i2", idea_id: "idea-1", variation_group_id: "batch-A" }),
    ];
    const groups = groupQueueRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("idea");
  });

  it("groups cross-channel idea rows into one idea group", () => {
    const rows = [
      row({ id: "x", idea_id: "idea-1", channel: "instagram" }),
      row({ id: "y", idea_id: "idea-1", channel: "linkedin" }),
    ];
    const groups = groupQueueRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("idea");
  });

  it("leaves a standalone row (no idea, no batch) as single", () => {
    const groups = groupQueueRows([row({ id: "solo" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("single");
  });

  it("sorts groups by earliest scheduled_at, undated last", () => {
    const rows = [
      row({ id: "late", scheduled_at: "2026-07-01T10:00:00Z" }),
      row({ id: "early", scheduled_at: "2026-06-15T10:00:00Z" }),
      row({ id: "undated", scheduled_at: null }),
    ];
    const groups = groupQueueRows(rows);
    const ids = groups.map((g) => (g.kind === "single" ? g.row.id : ""));
    expect(ids).toEqual(["early", "late", "undated"]);
  });
});

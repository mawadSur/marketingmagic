import { describe, expect, it } from "vitest";
import {
  flattenPlanVariants,
  buildVoiceMemoPosts,
  VOICE_SCORE_THRESHOLD,
  type PersistAccount,
} from "@/lib/voice-memo/persist";
import type { GeneratedPlan } from "@/lib/plan/schema";

// ── Unit: voice-memo plan persistence fan-out (Phase 2.6) ─────────────────
//
// persistVoiceMemoPlan's DB-touching shell isn't worth mocking; its VALUE is
// the pure fan-out, which we cover directly:
//   • flattenPlanVariants — ideas[]→variants, drops skip:true, falls back to
//     the legacy posts[] shape.
//   • buildVoiceMemoPosts — voice_score/trust-mode/low_confidence rules,
//     per-channel max-chars truncation, unconnected-channel skip, and the
//     source_id + generation_metadata.voice_memo=true stamp on EVERY row.

const X_MAX = 280;

function plan(over?: Partial<GeneratedPlan>): GeneratedPlan {
  return {
    plan_name: "Voice memo plan",
    overview: "From a voice memo.",
    ideas: [
      {
        idea_label: "Idea A",
        theme: "build-progress",
        suggested_scheduled_at: "2026-06-10T14:00:00Z",
        variants: [
          { channel: "x", text: "short x post", rationale: "fits x", skip: false, voice_score: 90 },
          { channel: "linkedin", text: "a longer linkedin post", rationale: "fits li", skip: false, voice_score: 40 },
          { channel: "bluesky", text: "should be dropped", rationale: "essay→skip bsky", skip: true },
        ],
      },
    ],
    ...over,
  } as GeneratedPlan;
}

const connected: PersistAccount[] = [
  { id: "acct-x", channel: "x", handle: "@me", trust_mode: true },
  { id: "acct-li", channel: "linkedin", handle: "me", trust_mode: true },
];

function build(p: GeneratedPlan, accounts: PersistAccount[], hasVoiceProfile: boolean) {
  return buildVoiceMemoPosts({
    variants: flattenPlanVariants(p),
    accounts,
    planId: "plan-1",
    workspaceId: "ws-1",
    sourceId: "src-1",
    hasVoiceProfile,
    cacheReadInputTokens: 7,
    briefFingerprint: "fp-test",
  });
}

describe("flattenPlanVariants", () => {
  it("flattens ideas[] and drops skip:true variants", () => {
    const flat = flattenPlanVariants(plan());
    expect(flat.map((v) => v.channel)).toEqual(["x", "linkedin"]);
    // Variants of one idea share a generated idea_id.
    expect(flat[0]!.idea_id).toBe(flat[1]!.idea_id);
    expect(flat[0]!.idea_id).toBeTruthy();
  });

  it("falls back to the legacy posts[] shape (idea_id null)", () => {
    const legacy = {
      plan_name: "Legacy",
      overview: "o",
      posts: [
        {
          channel: "x",
          text: "legacy post",
          theme: "t",
          suggested_scheduled_at: "2026-06-10T14:00:00Z",
          rationale: "r",
        },
      ],
    } as unknown as GeneratedPlan;
    const flat = flattenPlanVariants(legacy);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.idea_id).toBeNull();
    expect(flat[0]!.idea_label).toBeNull();
  });
});

describe("buildVoiceMemoPosts — voice_memo stamp", () => {
  it("stamps source_id + generation_metadata.voice_memo=true on every post", () => {
    const { posts } = build(plan(), connected, false);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.source_id).toBe("src-1");
      const meta = post.generation_metadata as Record<string, unknown>;
      expect(meta.voice_memo).toBe(true);
      expect(meta.source_id).toBe("src-1");
      expect(meta.cache_read_input_tokens).toBe(7);
    }
  });
});

describe("buildVoiceMemoPosts — unconnected channel skip", () => {
  it("skips variants whose channel isn't connected and reports them", () => {
    const { posts, skipped } = build(plan(), [connected[0]!], false);
    // Only X is connected → LinkedIn is skipped.
    expect(posts.map((p) => p.channel)).toEqual(["x"]);
    expect(skipped).toEqual(["linkedin"]);
  });
});

describe("buildVoiceMemoPosts — max-chars truncation", () => {
  it("truncates over-cap text to the channel max with an ellipsis", () => {
    const long = "a".repeat(X_MAX + 50);
    const p = plan({
      ideas: [
        {
          idea_label: "L",
          theme: "t",
          suggested_scheduled_at: "2026-06-10T14:00:00Z",
          variants: [{ channel: "x", text: long, rationale: "r", skip: false }],
        },
      ],
    });
    const { posts } = build(p, [connected[0]!], false);
    expect(posts[0]!.text.length).toBe(X_MAX);
    expect(posts[0]!.text.endsWith("…")).toBe(true);
  });

  it("leaves under-cap text untouched", () => {
    const { posts } = build(plan(), [connected[0]!], false);
    expect(posts[0]!.text).toBe("short x post");
  });
});

describe("buildVoiceMemoPosts — trust-mode + low_confidence gating", () => {
  it("auto-schedules a trusted account's high-voice-score post", () => {
    const { posts } = build(plan(), [connected[0]!], true); // x has voice_score 90
    expect(posts[0]!.status).toBe("scheduled");
    expect(posts[0]!.low_confidence).toBe(false);
  });

  it("holds a trusted account's LOW-voice-score post for approval (with a voice profile)", () => {
    // LinkedIn has voice_score 40 < threshold 70, and a voice profile is set →
    // low_confidence true → never auto-scheduled even though trust_mode is on.
    const { posts } = build(plan(), [connected[1]!], true);
    expect(40).toBeLessThan(VOICE_SCORE_THRESHOLD);
    expect(posts[0]!.low_confidence).toBe(true);
    expect(posts[0]!.status).toBe("pending_approval");
  });

  it("ignores voice_score gating when the workspace has NO voice profile", () => {
    // Same low score, but hasVoiceProfile=false → not low_confidence → a
    // trusted account still auto-schedules.
    const { posts } = build(plan(), [connected[1]!], false);
    expect(posts[0]!.low_confidence).toBe(false);
    expect(posts[0]!.status).toBe("scheduled");
  });

  it("an untrusted account always lands in pending_approval", () => {
    const untrusted: PersistAccount = { ...connected[0]!, trust_mode: false };
    const { posts } = build(plan(), [untrusted], true);
    expect(posts[0]!.status).toBe("pending_approval");
  });
});

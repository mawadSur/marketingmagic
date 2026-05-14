// Phase 6.10 — Hashtag Intelligence types.
//
// Shape of a single hashtag suggestion served to the /queue UI and to the
// plan generator. The recommendation pipeline is data-driven by default
// (rank workspace history by recency-weighted engagement) and never
// auto-applies — the chip is *pre-checked* in the UI but the user owns
// the final toggle.

import type { ChannelId } from "@/lib/channels/registry";

// Reason buckets for `HashtagSuggestion.reason`. Discriminated so the UI
// can render a tiny "why" badge next to each chip.
export type HashtagReason =
  | "workspace_winner"   // historically above-average engagement in this workspace
  | "workspace_recent"   // used recently with neutral signal
  | "channel_default"    // cold-start fallback from per-channel sample tags
  | "draft_match";       // surfaced because the tag appears as a literal in the draft

export interface Hashtag {
  // Normalized: lowercase, no leading #. UI re-prepends `#` for display.
  tag: string;
}

export interface HashtagSuggestion extends Hashtag {
  // 0..1 — combined recency-weighted engagement signal. Pure rank; the
  // UI doesn't render this number, only sorts on it.
  confidence: number;
  reason: HashtagReason;
  // Per-channel context. Useful for the UI when the same tag has a
  // different rank on X vs IG.
  channel: ChannelId;
  // Optional sample-size hint ("3 posts, avg engagement 0.041"). UI may
  // show this on hover; we never strip it from the wire shape.
  sample_size?: number;
}

// Per-channel policy returned by getChannelHashtagPolicy().
// `recommendedCount` is a [min, max] range — the UI uses `max` as the
// chip count cap and `min` as the pre-check target.
export interface HashtagChannelRules {
  channel: ChannelId;
  // [min, max] — `min` is the pre-check target, `max` is the hard cap.
  recommendedCount: [number, number];
  // Short copy rendered above the chip row. Channel-aware and opinionated
  // — see PLAN.md / tasks.md for the rationale per channel.
  notes: string;
  // Whether the UI should show *any* chips at all. False for Bluesky
  // (algorithm penalizes hashtags) — even when historical posts had them,
  // we render an explanatory paragraph and no chips.
  showChips: boolean;
}

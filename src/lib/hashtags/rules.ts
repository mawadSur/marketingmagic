// Phase 6.10 — per-channel hashtag policy.
//
// Single source of truth for "how many tags belong on this channel and
// what's the operator-facing copy explaining why." The recommender, the
// /queue UI, and the plan generator prompt all read from here so the
// rules can never drift.
//
// Channel rules (final values — also surface in tasks.md Phase 6.10):
//   X:        0–1   ("algorithm penalizes spam — default empty")
//   LinkedIn: 3     ("3 niche hashtags is the sweet spot")
//   Threads:  1–2   ("conversational hashtags only")
//   Instagram: 8–15 ("mixed-tier: mega + mid + niche")
//   Bluesky:  0     ("no hashtags — skip entirely")
//
// Bluesky returns `showChips: false` so the UI can render an explanatory
// paragraph instead of an empty chip row. That guarantees the "default
// to no tags on Bluesky" rule even when historical posts had them.

import type { ChannelId } from "@/lib/channels/registry";
import type { HashtagChannelRules } from "./schema";

const POLICIES: Record<ChannelId, HashtagChannelRules> = {
  x: {
    channel: "x",
    recommendedCount: [0, 1],
    notes:
      "X recommends 0–1 hashtags — the algorithm penalizes spammy tag stacks. Default is no tag.",
    showChips: true,
  },
  linkedin: {
    channel: "linkedin",
    // [3, 3] — LinkedIn's published guidance: ~3 niche, on-topic tags.
    recommendedCount: [3, 3],
    notes:
      "LinkedIn rewards 3 niche hashtags. Favour audience-specific tags over mega-broad ones.",
    showChips: true,
  },
  threads: {
    channel: "threads",
    recommendedCount: [1, 2],
    notes: "Threads: 1–2 conversational hashtags. Less is more — match the casual register.",
    showChips: true,
  },
  instagram: {
    channel: "instagram",
    // [8, 15] — Instagram still rewards a meaningful tag mix; max 30 is
    // the hard ceiling but engagement plateaus well before that.
    recommendedCount: [8, 15],
    notes:
      "Instagram: 8–15 mixed-tier tags. Blend mega (10M+ posts), mid (100k–10M), and niche (<100k) for reach + relevance.",
    showChips: true,
  },
  bluesky: {
    channel: "bluesky",
    recommendedCount: [0, 0],
    notes: "Bluesky: skip hashtags. The platform's culture and algorithm both reward plain prose.",
    showChips: false,
  },
};

export function getChannelHashtagPolicy(channel: ChannelId): HashtagChannelRules {
  return POLICIES[channel];
}

// Cold-start: channels with no workspace history get these generic seed
// tags. Intentionally vague — we'd rather under-suggest than push the
// user toward a tag that doesn't fit their niche. The recommender blends
// these in only when workspace history is thin (<20 posts).
export const COLD_START_SEEDS: Record<ChannelId, string[]> = {
  x: ["build-in-public", "indiehackers"],
  linkedin: ["startup", "founders", "buildinpublic"],
  threads: ["startup", "building"],
  instagram: ["entrepreneur", "startup", "smallbusiness", "founder", "buildinpublic", "marketing", "creator", "smallbiz"],
  bluesky: [], // never recommend tags on Bluesky
};

// Tag-mix tier annotation for IG chips. Pure UI hint — derived from a
// simple length heuristic in the absence of a real tag-popularity DB.
// Short tags tend to be mega ("ai", "art"), long tags tend to be niche
// ("supabaserlsedgecases"). Mid is everything in between.
export type IgTagTier = "mega" | "mid" | "niche";

export function igTagTierFor(tag: string): IgTagTier {
  // 1–4 chars → mega. 5–10 → mid. >10 → niche.
  if (tag.length <= 4) return "mega";
  if (tag.length <= 10) return "mid";
  return "niche";
}

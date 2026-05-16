import { z } from "zod";
import type { CompetitorWatchChannel } from "@/lib/db/types";

// Phase 6.6 — Competitor Watch domain schemas + types.
//
// Two surfaces:
//
//   1. WatchHandleInput — what /competitors/add posts.
//   2. CompetitorPostShape — narrowed shape the fetch helpers return,
//      before insert into competitor_posts. The db row shape (with
//      computed engagement_rate + is_winner) lives in db/types.ts.

// Channels the watch list accepts. Mirrors the CHECK in migration 016
// and CompetitorWatchChannel in db/types.ts. Source of truth for the
// add-handle form's `<select>`.
export const COMPETITOR_CHANNELS = [
  "bluesky",
  "x",
  "linkedin",
  "instagram",
  "threads",
] as const satisfies ReadonlyArray<CompetitorWatchChannel>;

export const competitorChannelSchema = z.enum(COMPETITOR_CHANNELS);

// Bluesky / X scrape support is what V1 ships with. Others get inserted
// but the daily cron flags them failed with channel_unsupported. The UI
// uses this to mark rows "Coming soon" in the channel selector.
export function isCompetitorChannelSupported(channel: CompetitorWatchChannel): boolean {
  return channel === "bluesky" || channel === "x";
}

export const watchHandleInputSchema = z.object({
  channel: competitorChannelSchema,
  handle: z
    .string()
    .trim()
    .min(1, "Enter a handle.")
    .max(120, "Handle too long.")
    .refine((s) => !s.includes(" "), "Handles cannot contain spaces."),
  display_name: z.string().trim().max(120).optional(),
});
export type WatchHandleInput = z.infer<typeof watchHandleInputSchema>;

// Application-side normalisation. The DB has CHECK constraints but we
// normalise here so duplicates collide cleanly on the unique index.
export function normalizeHandle(channel: CompetitorWatchChannel, raw: string): string {
  const stripped = raw.trim().replace(/^@/, "").toLowerCase();
  // Bluesky: coerce bare usernames to *.bsky.social. The fetch helper
  // accepts either form; we pick the canonical to keep the unique index
  // from holding two rows for the same actor.
  if (channel === "bluesky" && stripped.length > 0 && !stripped.includes(".")) {
    return `${stripped}.bsky.social`;
  }
  return stripped;
}

// Result of a single per-channel pull. The cron upserts these into
// competitor_posts with the watch_handle_id we already know.
export interface FetchedCompetitorPost {
  external_id: string;
  posted_at: string; // ISO
  text: string;
  post_url: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  impressions: number | null;
}

// Per-handle fetch outcome. The cron uses `status` to update
// watch_handles.status + failure_reason.
export type FetchOutcome =
  | { status: "ok"; posts: FetchedCompetitorPost[] }
  | { status: "rate_limited"; reason: string }
  | { status: "failed"; reason: string };

// Claude pattern-extraction shape (Phase 6.6 task 6). One call per winner;
// cached per row so we never re-call Claude for the same competitor post.
export const competitorPatternSchema = z.object({
  // Reusable short tags. We constrain to a closed set in the prompt to
  // keep tags comparable across handles — free-form labels turn into
  // synonym soup over time.
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
  // One-line "possible reason this post outperformed." 'Possible' is
  // load-bearing — we don't claim causal attribution.
  reason: z.string().trim().min(1).max(280),
});
export type CompetitorPattern = z.infer<typeof competitorPatternSchema>;

// Allowed tag vocabulary. Constrains Claude to a comparable set across
// handles. Keep aligned with extract-pattern.ts's prompt and with the
// UI badge styling.
export const COMPETITOR_PATTERN_TAGS = [
  "vulnerability",
  "list",
  "contrarian",
  "data-driven",
  "question",
  "story",
  "how-to",
  "announcement",
  "controversial-take",
  "behind-the-scenes",
  "humor",
  "quote",
  "thread-starter",
] as const;
export type CompetitorPatternTag = (typeof COMPETITOR_PATTERN_TAGS)[number];

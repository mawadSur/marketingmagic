// Phase 8 (dedup wedge) — collect the workspace's own recently-posted and
// still-queued content for the planner.
//
// The plan generator has historically had zero memory of what it (or the user)
// already produced, so it would happily re-generate the same handful of angles
// every week. This collector closes that gap: it pulls a window of the
// workspace's recent + queued posts and projects each one down to the compact
// `RecentContentSignal` the system prompt renders (see recentContentBlock in
// src/lib/plan/prompt.ts). The planner then sees, at a glance, which themes are
// already saturated and which specific posts to avoid colliding with.
//
// We deliberately REUSE the dedup gate's corpus loader (loadRecentCorpus) rather
// than running a second query — the two surfaces want the same window (recent
// posted + queued content) and keeping them on one read means the planner's
// "what's already here" view can never drift from what the dedup gate dedupes
// against. The only job left here is the projection: clamp the text to a single
// short snippet, coerce the status into the prompt's narrower union, and cap the
// list to the newest few so the block stays scannable.

import type { RecentContentSignal } from "@/lib/plan/prompt";
import { loadRecentCorpus } from "@/lib/dedup/gate";

// The prompt block renders up to 24 newest items, so there's no value in
// projecting more than that. The lookback mirrors the dedup gate default (45d)
// so "recently posted or queued" means the same thing on both surfaces.
const DEFAULT_DAYS = 45;
const DEFAULT_CAP = 24;

// Hard clamp for the snippet — matches the ~140-char slice the rejection-feedback
// block already uses, long enough to recognise the angle, short enough to keep
// the list dense.
const SNIPPET_MAX = 140;

// The status values loadRecentCorpus queries for are exactly the three the
// prompt's RecentContentSignal union accepts ('posted' | 'scheduled' |
// 'pending_approval'), but the corpus types the column as a plain string, so we
// coerce defensively and drop anything outside the union.
const PROMPT_STATUSES = new Set<RecentContentSignal["status"]>([
  "posted",
  "scheduled",
  "pending_approval",
]);

function coerceStatus(status: string): RecentContentSignal["status"] | null {
  return PROMPT_STATUSES.has(status as RecentContentSignal["status"])
    ? (status as RecentContentSignal["status"])
    : null;
}

// Collapse all whitespace to single spaces, trim, then clamp to SNIPPET_MAX so
// the prompt line stays single-line and short.
function toSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

// Collect the recent-content signals for a workspace. Returns the newest items
// first (loadRecentCorpus already orders created_at desc), capped to `cap`.
// Returns [] when there's nothing recent — the prompt block then renders empty
// and the planner behaves exactly as it did before this wedge.
export async function collectRecentContent(
  workspaceId: string,
  opts: { days?: number; cap?: number } = {},
): Promise<RecentContentSignal[]> {
  const days = opts.days ?? DEFAULT_DAYS;
  const cap = opts.cap ?? DEFAULT_CAP;

  // loadRecentCorpus already returns newest-first and applies its own row cap;
  // we pass our `days` through and clamp the final list to `cap` here so the
  // planner's view is exactly what the block will render.
  const corpus = await loadRecentCorpus(workspaceId, days);

  const signals: RecentContentSignal[] = [];
  for (const post of corpus) {
    const status = coerceStatus(post.status);
    if (!status) continue; // skip anything outside the prompt's status union
    signals.push({
      theme: post.theme,
      status,
      snippet: toSnippet(post.text),
    });
    if (signals.length >= cap) break;
  }
  return signals;
}

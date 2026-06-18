// Pure grouping logic for the approval queue.
//
// Extracted from page.tsx so the bucketing decision — which rows collapse into
// a cross-channel idea, an X thread, a "30 variations" batch, or stay as a
// standalone row — is testable without rendering JSX, and so page.tsx stays
// under the file-size budget. page.tsx maps the returned QueueGroup[] to the
// matching row components; the decision lives here.

import type { ThreadTweetRow } from "@/components/thread-builder-ui";
import type { QueueMediaItem } from "./queue-row";
import { readThreadMeta } from "@/lib/threads/schema";

// The display shape page.tsx builds from the DB rows. Kept here because the
// grouping function is the primary consumer; page.tsx re-exports nothing.
export interface QueueDisplayRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
  media: QueueMediaItem[];
  image_prompt: string | null;
  mediaPublicUrl: string | null;
  voice_score: number | null;
  low_confidence: boolean;
  idea_id: string | null;
  external_id: string | null;
  failure_reason: string | null;
  generation_metadata: unknown;
  tags: string[];
  experiment_status: "parent" | "variant" | null;
  // Hormozi slice #4 — variation batch tag (migration 060). Non-null on
  // "Generate 30 variations" drafts; groups them into one collapsible row.
  variation_group_id: string | null;
  // T4.1 — serializable performance + dedup signals for the row chips. Both
  // are plain data (no ReactNode) so they cross the server/client boundary
  // cleanly, exactly like voice_score / low_confidence above. `perf` is only
  // set for posted rows we could actually score to a non-pending verdict;
  // `dedup` mirrors generation_metadata.dedup when a near/exact match flagged
  // this draft at insert time.
  perf?: QueuePerf | null;
  dedup?: QueueDedup | null;
}

// A row's performance chip data, distilled from PostPerformance to just what
// the chip renders. Kept tiny + serializable.
export interface QueuePerf {
  ratio: number | null;
  verdict: "winner" | "strong" | "average" | "underperformer";
}

// The dedup-on-hit stamp written into generation_metadata.dedup by the insert
// paths (see migration 067 + the dedup gate). Surfaced as the "Similar to a
// recent post" warning chip.
export interface QueueDedup {
  kind: "exact" | "near";
  score: number;
  match_snippet: string;
}

// One render unit in the queue, post-grouping. `sortKey` orders units against
// each other (earliest scheduled_at anchors a multi-row group).
export type QueueGroup =
  | { kind: "single"; row: QueueDisplayRow; sortKey: string }
  | { kind: "idea"; ideaId: string; variants: QueueDisplayRow[]; sortKey: string }
  | { kind: "variation"; groupId: string; variations: QueueDisplayRow[]; sortKey: string }
  | { kind: "thread"; ideaId: string; tweets: ThreadTweetRow[]; theme: string | null; sortKey: string };

// Fallback to a "z" prefix so rows without a scheduled_at land at the end
// rather than at the top via empty-string sort.
export function sortKeyOf(r: QueueDisplayRow): string {
  return r.scheduled_at ?? `zzz-${r.id}`;
}

/**
 * Bucket queue rows into render groups, sorted by scheduled_at.
 *
 * Precedence per row:
 *   1. idea_id set        → cross-channel idea (or X thread, if every member is
 *      a thread tweet on channel='x'); a single-member idea degrades to "single".
 *   2. variation_group_id → "30 filmable variations" batch (Hormozi slice #4);
 *      a single surviving member degrades to "single".
 *   3. otherwise          → standalone "single" row.
 *
 * idea_id wins over variation_group_id by construction — variation drafts carry
 * no idea_id (see src/lib/variations/run.ts), so the two buckets never overlap.
 */
export function groupQueueRows(rows: QueueDisplayRow[]): QueueGroup[] {
  const byIdea = new Map<string, QueueDisplayRow[]>();
  // Hormozi slice #4 — variation drafts carry no idea_id but share a
  // variation_group_id. Bucket them separately so a "30 variations" batch
  // collapses into one row instead of flooding the list with 30 loose drafts.
  const byVariationGroup = new Map<string, QueueDisplayRow[]>();
  const standalone: Array<{ row: QueueDisplayRow; sortKey: string }> = [];

  for (const r of rows) {
    if (r.idea_id) {
      const arr = byIdea.get(r.idea_id) ?? [];
      arr.push(r);
      byIdea.set(r.idea_id, arr);
    } else if (r.variation_group_id) {
      const arr = byVariationGroup.get(r.variation_group_id) ?? [];
      arr.push(r);
      byVariationGroup.set(r.variation_group_id, arr);
    } else {
      standalone.push({ row: r, sortKey: sortKeyOf(r) });
    }
  }

  const groups: QueueGroup[] = [];
  for (const s of standalone) {
    groups.push({ kind: "single", row: s.row, sortKey: s.sortKey });
  }
  for (const [groupId, variations] of byVariationGroup.entries()) {
    // A lone surviving variation (the rest approved/rejected away) degrades to
    // a plain row — a batch header over a single draft is just noise.
    if (variations.length === 1) {
      groups.push({ kind: "single", row: variations[0], sortKey: sortKeyOf(variations[0]) });
      continue;
    }
    const earliest = variations.map(sortKeyOf).sort()[0] ?? "";
    groups.push({ kind: "variation", groupId, variations, sortKey: earliest });
  }
  for (const [ideaId, variants] of byIdea.entries()) {
    // Phase 6.8: thread detection. Every row carries thread meta and
    // sits on channel='x' ⇒ this is a thread, not a cross-channel idea.
    const allThread = variants.every(
      (v) => v.channel === "x" && readThreadMeta(v.generation_metadata) !== null,
    );
    if (allThread && variants.length >= 2) {
      const tweets: ThreadTweetRow[] = variants
        .map((v) => {
          const m = readThreadMeta(v.generation_metadata)!;
          return {
            id: v.id,
            text: v.text,
            status: v.status,
            scheduled_at: v.scheduled_at,
            external_id: v.external_id,
            failure_reason: v.failure_reason,
            tweet_index: m.tweet_index,
            total_tweets: m.total_tweets,
            role: m.role,
          };
        })
        .sort((a, b) => a.tweet_index - b.tweet_index);
      const earliest = variants.map(sortKeyOf).sort()[0] ?? "";
      const theme = variants.find((v) => v.theme)?.theme ?? null;
      groups.push({ kind: "thread", ideaId, tweets, theme, sortKey: earliest });
      continue;
    }
    // Single-variant ideas degrade to a plain row — collapsing the header
    // would just be visual noise when there's nothing to compare against.
    if (variants.length === 1) {
      groups.push({ kind: "single", row: variants[0], sortKey: sortKeyOf(variants[0]) });
      continue;
    }
    const earliest = variants.map(sortKeyOf).sort()[0] ?? "";
    groups.push({ kind: "idea", ideaId, variants, sortKey: earliest });
  }

  groups.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return groups;
}

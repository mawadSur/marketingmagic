// Content dedup — the I/O half: load a workspace's recent corpus, then judge a
// batch of candidate posts against it.
//
// This is the gate every insert-path goes through before a new post is written
// (the planner, the variation engine, manual single-post creation, the API).
// It answers one practical question: "have we already queued or recently posted
// something that's the same as this?" — and if so, with what severity.
//
// Two verdicts, mirroring the two layers in src/lib/dedup/similarity.ts:
//
//   - "exact" — the normalised content hash collides with a prior post (or with
//     an earlier accepted candidate in THIS same batch). This is a re-queue of
//     the same caption, possibly with a different trailing link / casing /
//     emoji. We never want this to auto-publish.
//
//   - "near"  — trigram-Jaccard similarity to some prior/accepted post is at or
//     above NEAR_DUP_THRESHOLD. "Same post, lightly reworded." A human should
//     look before this ships.
//
//   - "ok"    — genuinely new content. It joins the running set so that LATER
//     candidates in the same batch dedup against it too (a 30-variation batch
//     that contains two identical variations should flag the second).
//
// Deliberately CHANNEL-AGNOSTIC: the same caption queued on X and on Instagram
// is still a duplicate. We dedup on the *words*, not on where they're going —
// re-posting identical copy across networks is exactly the spammy behaviour the
// gate exists to surface. The candidate's channel is carried through only so
// callers can correlate results back to their inputs.
//
// The corpus is loaded ONCE per dedupePosts() call and reused for every
// candidate, so a batch of N candidates is one DB read, not N.

import { supabaseService } from "@/lib/supabase/service";
import type { ChannelId } from "@/lib/channels/registry";
import type { PostStatus } from "@/lib/db/types";
import {
  hashContent,
  similarity,
  isNearDuplicate,
  type DupMatch,
} from "@/lib/dedup/similarity";

// How far back we look, and how many rows we pull at most. 45 days is wide
// enough to catch a "I posted this last month" repeat without dragging in
// ancient content that's fair game to revisit; 120 rows caps the work and the
// memory for a busy workspace (newest first, so we keep the most relevant).
const DEFAULT_DAYS = 45;
const DEFAULT_CAP = 120;

// The post states that count as "already taken." A draft isn't committed to
// anything, so it doesn't block — but anything queued (scheduled /
// pending_approval) or already out (posted) does.
const ACTIVE_STATUSES: PostStatus[] = ["posted", "scheduled", "pending_approval"];

// One prior post pulled into the dedup corpus. We keep both the stored
// content_hash (when the row already has one — the fast exact-match path) and
// the raw text (so we can recompute a hash for old rows written before the
// content_hash column existed, and run trigram similarity for near-matches).
export interface RecentPost {
  id: string;
  text: string;
  theme: string | null;
  status: string;
  content_hash: string | null;
}

/**
 * Internal: load the recent post corpus, distinguishing a genuine READ FAILURE
 * from a successful-but-empty read.
 *
 *   - returns RecentPost[] (possibly empty) on a successful query, and
 *   - returns null when the query ERRORED or returned no data object.
 *
 * The null sentinel lets dedupePosts implement a fail-SAFE policy (a DB blip
 * must never let a duplicate auto-publish), while the public loadRecentCorpus
 * below collapses null to [] to preserve its long-standing fail-OPEN contract
 * for collectRecentContent and other read-only callers.
 */
async function loadRecentCorpusOrNull(
  workspaceId: string,
  days: number = DEFAULT_DAYS,
  cap: number = DEFAULT_CAP,
): Promise<RecentPost[] | null> {
  const svc = supabaseService();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from("posts")
    .select("id, text, theme, status, content_hash")
    .eq("workspace_id", workspaceId)
    .in("status", ACTIVE_STATUSES)
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(cap);

  if (error || !data) return null;
  return data as unknown as RecentPost[];
}

/**
 * Load the recent post corpus for a workspace — the prior art a new candidate
 * is checked against. Newest first so a CAP trims the oldest rows.
 *
 * On any query error we return [] (fail-open): the dedup gate is a guardrail,
 * not a hard dependency, and a transient read failure should never block a
 * workspace from creating content. (dedupePosts opts into a stricter fail-SAFE
 * mode separately via loadRecentCorpusOrNull.)
 */
export async function loadRecentCorpus(
  workspaceId: string,
  days: number = DEFAULT_DAYS,
  cap: number = DEFAULT_CAP,
): Promise<RecentPost[]> {
  // Collapse the read-failure sentinel to [] so read-only callers
  // (collectRecentContent et al.) keep degrading gracefully.
  return (await loadRecentCorpusOrNull(workspaceId, days, cap)) ?? [];
}

// A single piece of candidate text the caller wants to insert, plus the channel
// it's destined for (carried through for the caller's bookkeeping; the gate
// itself ignores channel when judging duplication).
export interface DedupCandidate {
  text: string;
  channel: ChannelId;
}

// The gate's verdict for one candidate, by position in the input array.
//   - "ok"    — write it (it also joins the running set for later candidates).
//   - "exact" — content-hash collision; `match` points at the prior/earlier hit.
//   - "near"  — trigram similarity >= threshold; `match.score` is the best score.
export interface DedupResult {
  index: number;
  verdict: "ok" | "exact" | "near";
  match?: DupMatch;
}

// Internal: the running comparison set is the loaded corpus PLUS every candidate
// we've already accepted in this batch. We model an accepted candidate the same
// shape we compare against — an id, its text, and its content hash.
interface CorpusEntry {
  id: string;
  text: string;
  hash: string; // always populated (recomputed from text when the row had none)
}

/**
 * Dedup a batch of candidates against a workspace's recent corpus AND against
 * each other.
 *
 * Algorithm, per candidate in order:
 *   1. EXACT — hash the candidate. If that hash matches any entry's hash, it's
 *      an exact dup. (Entries' hashes come from the stored content_hash when
 *      present, else recomputed from the entry's text — so pre-migration rows
 *      and intra-batch siblings are both covered.)
 *   2. NEAR  — otherwise, compute trigram similarity against every entry and
 *      take the max. If that max >= NEAR_DUP_THRESHOLD, it's a near dup.
 *   3. OK    — otherwise it's new. We append it to the running set so the next
 *      candidate is also checked against it.
 *
 * Empty / whitespace-only candidate text can't form a content hash (hashContent
 * returns "" for it) and can't usefully be compared — we let it through as "ok"
 * and leave length/empty validation to the caller's own boundary checks.
 *
 * CORPUS READ FAILURE policy (opts.failSafe):
 *   - failSafe FALSE/absent (default) → fail-OPEN: a read failure is treated as
 *     an empty corpus, so every candidate comes back "ok". A transient DB blip
 *     never blocks content creation. This is right for low-stakes callers
 *     (atomize / variation regen) that already treat the gate as best-effort.
 *   - failSafe TRUE → fail-SAFE: a read failure flags EVERY candidate as "near"
 *     with a placeholder match, so the caller's existing "near" handling routes
 *     them to pending_approval. A duplicate can therefore never auto-publish
 *     while the corpus is unreadable — at the cost of a manual-review nudge.
 *
 * The return shape is unchanged (DedupResult[]) in both modes, so existing
 * callers are unaffected.
 */
export async function dedupePosts(
  workspaceId: string,
  candidates: DedupCandidate[],
  opts: { failSafe?: boolean } = {},
): Promise<DedupResult[]> {
  if (candidates.length === 0) return [];

  // One read for the whole batch. null === the read genuinely FAILED (distinct
  // from a successful empty read, which is []).
  const corpus = await loadRecentCorpusOrNull(workspaceId);

  if (corpus === null) {
    // Corpus unreadable. Under fail-SAFE, flag every candidate as "near" so the
    // caller routes it to pending_approval (a dup can't slip through during a DB
    // blip). The match is a clearly-labelled placeholder with an EMPTY existingId
    // (never a real posts.id) and intraBatch:false so no consumer mistakes it for
    // a foreign key. Under fail-OPEN (default) we fall through to an empty corpus.
    if (opts.failSafe) {
      return candidates.map((_, index) => ({
        index,
        verdict: "near" as const,
        match: {
          existingId: "",
          existingText: "(dedup temporarily unavailable — flagged for manual review)",
          score: 1,
          kind: "near" as const,
          intraBatch: false,
        },
      }));
    }
  }

  // Seed the running comparison set from the corpus (empty when the read failed
  // under fail-OPEN). Recompute a hash from text whenever the stored content_hash
  // is missing (older rows), so the exact-match path is reliable regardless of
  // when a row was written.
  const entries: CorpusEntry[] = (corpus ?? []).map((p) => ({
    id: p.id,
    text: p.text,
    hash: p.content_hash && p.content_hash !== "" ? p.content_hash : hashContent(p.text),
  }));

  const results: DedupResult[] = [];

  for (let index = 0; index < candidates.length; index++) {
    const text = candidates[index]!.text;
    const candidateHash = hashContent(text);

    // 1. Exact: a content-hash collision. Skip entries with an empty hash so an
    //    empty candidate can't "match" an empty entry.
    let exact: CorpusEntry | undefined;
    if (candidateHash !== "") {
      exact = entries.find((e) => e.hash !== "" && e.hash === candidateHash);
    }
    if (exact) {
      results.push({
        index,
        verdict: "exact",
        match: {
          existingId: exact.id,
          existingText: exact.text,
          score: 1,
          kind: "exact",
          // An earlier candidate in THIS batch, not a real posts row.
          intraBatch: exact.id.startsWith("candidate:"),
        },
      });
      continue;
    }

    // 2. Near: highest-scoring entry that actually qualifies as a near-dup.
    //    isNearDuplicate() is the length-aware classifier — for short posts it
    //    demands a minimum absolute shared-trigram overlap on top of clearing
    //    the Jaccard threshold, so we must score against THAT (not a bare
    //    similarity >= threshold) and report the best entry that passes it.
    let best: CorpusEntry | undefined;
    let bestScore = 0;
    for (const e of entries) {
      if (!isNearDuplicate(text, e.text)) continue;
      const score = similarity(text, e.text);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) {
      results.push({
        index,
        verdict: "near",
        match: {
          existingId: best.id,
          existingText: best.text,
          score: bestScore,
          kind: "near",
          // An earlier candidate in THIS batch, not a real posts row.
          intraBatch: best.id.startsWith("candidate:"),
        },
      });
      continue;
    }

    // 3. Ok: genuinely new. It joins the running set so later candidates dedup
    //    against it (intra-batch). We give it a synthetic id so a downstream
    //    match against it is still attributable to "this batch, item N".
    results.push({ index, verdict: "ok" });
    entries.push({ id: `candidate:${index}`, text, hash: candidateHash });
  }

  return results;
}

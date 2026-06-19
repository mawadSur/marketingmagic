// Content dedup — the pure, math-only half.
//
// This module answers one question with zero I/O: "how alike are two pieces
// of post text?" It's used by the dedup gate (src/lib/dedup/gate.ts) to stop
// the planner (and every other insert-path) from re-queuing something the
// workspace already has scheduled or has recently posted.
//
// The design is deliberately boring and deterministic so it can be unit
// tested exhaustively and so two callers always agree on what a "duplicate"
// is. Two layers:
//
//   1. EXACT match — a stable content hash. We normalise the text first
//      (lowercase, strip accents/URLs/@mentions/#hashtags/punctuation,
//      collapse whitespace) and sha256 the result. So "Ship it 🚀 https://x.co"
//      and "ship it" hash identically. Cheap, O(1) set lookup upstream.
//
//   2. NEAR match — word-trigram Jaccard similarity. We slide a 3-word
//      window over the normalised text, build the set of trigrams, and take
//      |A ∩ B| / |A ∪ B|. Trigrams (not bag-of-words) because word ORDER is
//      most of what makes two captions "the same post reworded" vs. "two
//      different posts on the same theme". A single swapped word in a long
//      post barely dents the trigram overlap; a genuinely different post on
//      the same topic shares almost no 3-word runs.
//
// Why trigrams and not embeddings? No new npm deps (Node `crypto` + inline
// math only), it's instant, and it's explainable — when we flag a near-dup
// we can point at the exact prior post. Embeddings would catch paraphrases
// trigrams miss, but the failure mode here is "let a near-identical repost
// through," which a human approval gate then catches; over-blocking genuine
// new content would be worse.
//
// Short posts (<3 words) can't form a trigram, so for them similarity falls
// back to exact normalised-string equality — "Sale!" vs "Sale" is either the
// same or it isn't; fuzzy matching three-word-or-shorter text is noise.

import crypto from "node:crypto";

// Trigram word-join separator. We use U+241F (SYMBOL FOR UNIT SEPARATOR), a
// printable glyph that can never appear in normalised text (which is
// [a-z0-9 ] only), so "a b c" and "a bc" can't collide into the same trigram.
const WORD_SEP = "␟";

// At or above this trigram-Jaccard score we treat two posts as near
// duplicates. 0.6 means a clear majority of 3-word runs are shared — empirically
// the line between "this is the same post reworded" and "same theme, new post."
export const NEAR_DUP_THRESHOLD = 0.6;

// Length-aware near-dup guard. Below this word count a post is "short" and the
// pure 0.6 Jaccard rule over-flags: a single shared 3–4 word run can dominate a
// small trigram set and push two genuinely different short posts past 0.6 (e.g.
// "here is the secret to growth" vs "...to failure" share most of their few
// trigrams). For short posts we additionally require a minimum ABSOLUTE number
// of shared trigrams, so one coincidental run isn't enough on its own. Long
// posts (>= this many words) have enough trigrams that the ratio is meaningful
// on its own, so they keep the pure threshold rule.
const SHORT_POST_WORDS = 12;

// Minimum shared trigrams a SHORT post pair must have (on top of clearing the
// Jaccard threshold) to count as near.
//
// Why 4 and not 3: a single shared CONTIGUOUS 5-word run already yields exactly
// 3 trigrams (e.g. "here is the secret to growth" vs "...to failure" share the
// 5-word prefix → 3 trigrams, Jaccard 0.6). Those 3 are not independent signal —
// they're one coincidental phrase. Requiring at least 4 means the overlap must
// extend BEYOND any single shared run before we call two short posts near,
// which is exactly the over-flagging this guard exists to stop.
const MIN_SHARED_TRIGRAMS_SHORT = 4;

// A hit returned by the gate: which prior post matched, and how.
export interface DupMatch {
  existingId: string;
  existingText: string;
  score: number;
  kind: "exact" | "near";
  // True when the match is an EARLIER CANDIDATE in the same batch (existingId is
  // a synthetic "candidate:N", not a real posts.id). Downstream consumers must
  // not treat such an id as a foreign key into posts.
  intraBatch?: boolean;
}

/**
 * Canonicalise post text for comparison. The whole point is to erase the
 * differences that don't change what a reader perceives as "the same post":
 * casing, accents, links, @mentions, #hashtags, punctuation and emoji, and
 * runs of whitespace. What survives is a lowercase ascii word-stream.
 *
 * Order matters: we strip URLs/mentions/hashtags BEFORE the catch-all
 * punctuation strip so that e.g. "#growth" disappears entirely rather than
 * leaving the bare word "growth" behind.
 */
export function normalizeContent(text: string): string {
  return (
    text
      // 1. Case-fold.
      .toLowerCase()
      // 2. Decompose accents (é → e + ◌́) then drop the combining marks, so
      //    "café" and "cafe" canonicalise to the same thing.
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      // 3. Links carry no semantic content for dedup and vary post-to-post
      //    (utm params etc.) — a trailing share link must not make two
      //    otherwise-identical captions look different.
      .replace(/https?:\/\/\S+/g, " ")
      // 4. @mentions and #hashtags are decoration around the message.
      .replace(/[#@]\w+/g, " ")
      // 5. Everything that isn't a lowercase letter, digit or space goes —
      //    this also nukes emoji and remaining punctuation.
      .replace(/[^a-z0-9 ]+/g, " ")
      // 6. Collapse the whitespace the strips above left behind, then trim.
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Stable content hash for the EXACT-match layer. Accepts either raw or
 * already-normalised text — it normalises internally, so callers never have
 * to remember which they're holding.
 *
 * Empty or whitespace-only content normalises to "" and we return "" rather
 * than hashing the empty string: a hash of nothing is not a real post, and
 * we never want two empty/whitespace candidates to collide as "exact dups."
 */
export function hashContent(textOrNormalized: string): string {
  const normalized = normalizeContent(textOrNormalized);
  if (normalized === "") return "";
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Build the set of word-trigrams for already-normalised text. Sliding window
 * of 3 consecutive words joined by WORD_SEP. Fewer than 3 words → empty set
 * (no trigram can be formed; the caller falls back to exact equality).
 */
export function contentTrigrams(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean);
  const grams = new Set<string>();
  if (words.length < 3) return grams;
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(words[i] + WORD_SEP + words[i + 1] + WORD_SEP + words[i + 2]);
  }
  return grams;
}

/**
 * Jaccard index of two sets: |A ∩ B| / |A ∪ B|. Two empty sets are treated
 * as 0 (not 1) — "no trigrams" is the absence of a signal, not a perfect
 * match. The similarity() wrapper handles the short-text case before it gets
 * here, so an empty-vs-empty result never silently scores 1.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set for the intersection count.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) {
    if (large.has(g)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Count of trigrams shared by two trigram SETS (|A ∩ B|). */
function sharedTrigrams(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) {
    if (large.has(g)) shared += 1;
  }
  return shared;
}

/** Count of trigrams shared by two already-normalised strings (|A ∩ B|). */
function sharedTrigramCount(na: string, nb: string): number {
  return sharedTrigrams(contentTrigrams(na), contentTrigrams(nb));
}

/**
 * Similarity of two raw post strings on a 0..1 scale.
 *
 *   - Normalise both first.
 *   - If EITHER side normalises to "" → 0. A post that normalises to empty (a
 *     bare link, emoji-only, hashtag-only) carries no comparable signal and must
 *     NEVER read as a near/exact dup of anything — otherwise two unrelated
 *     empty-normalising posts would both score 1 and get false-flagged.
 *   - Identical (non-empty) normalised strings → 1 (covers e.g. same caption +
 *     different trailing link, which normalise equal).
 *   - If EITHER side is shorter than 3 words → exact normalised-equality
 *     (1 or 0). Fuzzy-matching very short text is meaningless.
 *   - Otherwise → trigram Jaccard.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeContent(a);
  const nb = normalizeContent(b);

  // Empty-normalising content has no comparable signal — never a dup of anything.
  if (na === "" || nb === "") return 0;

  if (na === nb) return 1;

  const wordsA = na.split(" ").filter(Boolean).length;
  const wordsB = nb.split(" ").filter(Boolean).length;
  if (wordsA < 3 || wordsB < 3) {
    // Already know na !== nb here, so short-text equality is necessarily 0.
    return 0;
  }

  return jaccard(contentTrigrams(na), contentTrigrams(nb));
}

/**
 * Gate-facing near-dup classifier — the single source of truth for "are these
 * two posts the same post lightly reworded?" The dedup gate calls THIS (not a
 * bare `similarity() >= NEAR_DUP_THRESHOLD`) so its near-detection inherits the
 * length-aware rule below.
 *
 * Rule:
 *   - Both sides must clear the Jaccard threshold (>= NEAR_DUP_THRESHOLD).
 *   - For SHORT posts (the shorter side has < SHORT_POST_WORDS words) we ALSO
 *     require >= MIN_SHARED_TRIGRAMS_SHORT shared trigrams. Short posts have so
 *     few trigrams that one coincidental 3–4 word run can clear 0.6 on its own;
 *     demanding a minimum absolute overlap stops that over-flagging.
 *   - For LONG posts (both sides >= SHORT_POST_WORDS words) the ratio is already
 *     meaningful, so the pure threshold stands.
 *
 * An identical pair scores 1 and is always near; an empty-normalising side
 * scores 0 and is never near — both fall out of the score check for free.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const score = similarity(a, b);
  if (score < NEAR_DUP_THRESHOLD) return false;

  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  const minWords = Math.min(
    na.split(" ").filter(Boolean).length,
    nb.split(" ").filter(Boolean).length,
  );

  // Long enough on both sides → the Jaccard ratio alone is trustworthy.
  if (minWords >= SHORT_POST_WORDS) return true;

  // Short pair → demand a minimum absolute shared-trigram count too.
  return sharedTrigramCount(na, nb) >= MIN_SHARED_TRIGRAMS_SHORT;
}

// ── Precompiled fast-path ─────────────────────────────────────────────────────
//
// The gate compares one candidate against a whole corpus (and every accepted
// candidate against every later one). Re-normalising + re-building trigrams for
// the same string on every pair is wasted work. CompiledText caches a string's
// normalised form, word count and trigram set so the gate computes each ONCE.
// The *Compiled helpers below are behaviour-identical to similarity() /
// isNearDuplicate() — they just read the cache instead of recomputing.

export interface CompiledText {
  normalized: string;
  wordCount: number;
  trigrams: Set<string>;
}

/** Compile a raw string once for repeated comparison (one normalise, one split). */
export function compileText(text: string): CompiledText {
  const normalized = normalizeContent(text);
  const words = normalized.split(" ").filter(Boolean);
  const trigrams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) {
    trigrams.add(words[i] + WORD_SEP + words[i + 1] + WORD_SEP + words[i + 2]);
  }
  return { normalized, wordCount: words.length, trigrams };
}

/** similarity() over precompiled inputs — identical result, no recomputation. */
export function similarityCompiled(a: CompiledText, b: CompiledText): number {
  if (a.normalized === "" || b.normalized === "") return 0;
  if (a.normalized === b.normalized) return 1;
  if (a.wordCount < 3 || b.wordCount < 3) return 0;
  return jaccard(a.trigrams, b.trigrams);
}

/** isNearDuplicate() over precompiled inputs — identical result, no recomputation. */
export function isNearDuplicateCompiled(a: CompiledText, b: CompiledText): boolean {
  const score = similarityCompiled(a, b);
  if (score < NEAR_DUP_THRESHOLD) return false;
  const minWords = Math.min(a.wordCount, b.wordCount);
  if (minWords >= SHORT_POST_WORDS) return true;
  return sharedTrigrams(a.trigrams, b.trigrams) >= MIN_SHARED_TRIGRAMS_SHORT;
}

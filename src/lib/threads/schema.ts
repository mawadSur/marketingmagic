// Phase 6.8 — Auto-Thread Builder (X-only).
//
// Zod schema for a Claude-generated X thread. The generator emits a flat
// array of tweets; we store them as N rows on the `posts` table (one row
// per tweet) all sharing an `idea_id`, each row tagging itself in
// `generation_metadata.thread` with `tweet_index`, `role`, and the
// thread-wide `total_tweets`.
//
// Hard rules:
// - Max 25 tweets in a thread (UI-paging gets ugly past that and the
//   X audience tunes out).
// - Each tweet body ≤ 280 chars (X hard cap).
// - The hook (tweet_number 1) must be <= 200 chars so it actually reads
//   as a hook — we don't want a wall-of-text first tweet.
// - Exactly one tweet has role='hook' (must be tweet_number 1).
// - Exactly one tweet has role='close' (must be the last tweet).
// - Every other tweet has role='body'.

import { z } from "zod";

// Max chars per tweet on X. Mirrors CHANNELS.x.maxChars but inlined to
// avoid the registry import (this module is referenced from server
// actions and the schema is hot-pathed during validation).
export const X_TWEET_MAX = 280;

// Hook ceiling — first tweet should be punchy, not a 4-line lede.
export const HOOK_MAX = 200;

// Lower bound: a 1-tweet "thread" is just a regular post. The thread
// builder requires at least 3 tweets so the hook/body/close shape makes
// sense; if you only have 2 things to say, post a single tweet.
export const THREAD_MIN_TWEETS = 3;
export const THREAD_MAX_TWEETS = 25;

export const threadTweetSchema = z
  .object({
    // 1-indexed position in the thread. The cron + UI rely on this for
    // sequencing; we re-validate that the numbers form a strict 1..N
    // sequence in `threadStructureSchema` below.
    tweet_number: z.number().int().min(1).max(THREAD_MAX_TWEETS),
    text: z
      .string()
      .trim()
      .min(1, "tweet text required")
      .max(X_TWEET_MAX, `tweet exceeds ${X_TWEET_MAX} characters`),
    role: z.enum(["hook", "body", "close"]),
  })
  .superRefine((t, ctx) => {
    if (t.role === "hook" && t.text.length > HOOK_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: HOOK_MAX,
        inclusive: true,
        path: ["text"],
        message: `hook exceeds ${HOOK_MAX} characters — make it punchier`,
      });
    }
  });

export const threadStructureSchema = z
  .array(threadTweetSchema)
  .min(THREAD_MIN_TWEETS, `thread needs at least ${THREAD_MIN_TWEETS} tweets`)
  .max(THREAD_MAX_TWEETS, `thread caps at ${THREAD_MAX_TWEETS} tweets`)
  .superRefine((tweets, ctx) => {
    // tweet_number must be a strict 1..N sequence — no gaps, no dupes.
    const numbers = tweets.map((t) => t.tweet_number).sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "tweet_number"],
          message: `tweet_number must be a 1..${tweets.length} sequence; saw ${numbers[i]} at position ${i + 1}`,
        });
        return;
      }
    }

    // Role discipline: tweet 1 = hook, last = close, middles = body.
    const ordered = [...tweets].sort((a, b) => a.tweet_number - b.tweet_number);
    if (ordered[0].role !== "hook") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [0, "role"],
        message: "first tweet must have role='hook'",
      });
    }
    const lastIdx = ordered.length - 1;
    if (ordered[lastIdx].role !== "close") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [lastIdx, "role"],
        message: "last tweet must have role='close'",
      });
    }
    for (let i = 1; i < ordered.length - 1; i++) {
      if (ordered[i].role !== "body") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "role"],
          message: "middle tweets must have role='body'",
        });
      }
    }
  });

export type ThreadTweet = z.infer<typeof threadTweetSchema>;
export type ThreadStructure = z.infer<typeof threadStructureSchema>;

// ─────────────────────────────────────────────────────────────
// Per-row generation_metadata.thread payload
// ─────────────────────────────────────────────────────────────
//
// Stored verbatim on each `posts` row that belongs to a thread. The
// /queue UI, the posting cron, and the partial-retry action all read
// this shape to detect threads + know each tweet's position.
//
// Why on `generation_metadata` instead of a new column: keeps Phase 6.8
// migration-free, mirrors how Phase 2.5 stored `image_prompt`, and
// degrades gracefully — code that doesn't know about threads just sees
// a normal `posts` row.
export interface ThreadRowMeta {
  is_thread: true;
  tweet_index: number; // 1-indexed; matches threadTweetSchema.tweet_number
  total_tweets: number;
  role: "hook" | "body" | "close";
}

// Type guard — narrows an arbitrary generation_metadata blob to one
// that carries thread metadata. Used by the cron + retry action.
export function readThreadMeta(meta: unknown): ThreadRowMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const t = (meta as { thread?: unknown }).thread;
  if (!t || typeof t !== "object") return null;
  const r = t as Partial<ThreadRowMeta>;
  if (r.is_thread !== true) return null;
  if (typeof r.tweet_index !== "number" || r.tweet_index < 1) return null;
  if (typeof r.total_tweets !== "number" || r.total_tweets < 1) return null;
  if (r.role !== "hook" && r.role !== "body" && r.role !== "close") return null;
  return {
    is_thread: true,
    tweet_index: r.tweet_index,
    total_tweets: r.total_tweets,
    role: r.role,
  };
}

// Rate limiting for AI-spend routes (handle-finder, start-preview, etc.).
//
// V1: Upstash Redis token-bucket limiter. When UPSTASH envs are set, rate limits
// are distributed across all instances (correct on Vercel serverless). When unset,
// this is a graceful no-op (logs once, allows) so the app boots without Upstash.
//
// The bucket is per-workspace OR per-IP, keyed by `{prefix}:{key}`. The limit is
// configurable per call site (default 10 req / 60s per key).

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { serverEnv } from "@/lib/env";

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

let cachedLimiter: Ratelimit | null = null;
let loggedNoOp = false;

function getLimiter(limit: number, windowMs: number): Ratelimit | null {
  if (cachedLimiter) return cachedLimiter;

  const env = serverEnv();
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (!loggedNoOp) {
      console.warn(
        "[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is unset. " +
          "Rate limiting is DISABLED (allows all). Set both envs to enable.",
      );
      loggedNoOp = true;
    }
    return null;
  }

  const redis = new Redis({ url, token });
  cachedLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowMs}ms`),
    analytics: true,
    prefix: "rl",
  });
  return cachedLimiter;
}

/**
 * Check the rate limit for the given key. Returns `ok: true` when under the cap,
 * `ok: false` when over. When Upstash is unconfigured, this is a no-op (always
 * allows, logs once).
 *
 * @param prefix - Namespace for the bucket (e.g., "handle-finder", "start-preview").
 * @param key - The identifier to rate-limit on (workspace id, IP address, etc.).
 * @param limit - Max requests allowed in the window (default 10).
 * @param windowMs - Window duration in milliseconds (default 60000 = 1 minute).
 */
export async function checkRateLimit(
  prefix: string,
  key: string,
  limit = 10,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const limiter = getLimiter(limit, windowMs);
  if (!limiter) {
    // Upstash unconfigured — allow all (no-op). Return a synthetic "ok" result
    // so the call site doesn't need to special-case the unconfigured state.
    return { ok: true, limit, remaining: limit, resetMs: windowMs };
  }

  const identifier = `${prefix}:${key}`;
  const result = await limiter.limit(identifier);

  return {
    ok: result.success,
    limit: result.limit,
    remaining: result.remaining,
    resetMs: result.reset - Date.now(),
  };
}

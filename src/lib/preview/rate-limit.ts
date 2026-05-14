// Per-IP rate limit for the Magic Moment landing form.
//
// V1: in-memory sliding-window counter. Lives in the Node.js process; on
// Vercel serverless each instance has its own bucket, so attackers who
// rotate cold-start nodes will get more attempts than the documented cap.
// Acceptable for V1 since the upstream cost (one Claude call) is bounded
// and we'll move to Upstash/Redis once we see actual abuse — flagged below.
//
// For a hard rate-limit guarantee, swap `recordAttempt` for an Upstash
// Redis INCR + EXPIRE call. Same interface; just rip the Map.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS = 5;

// Keyed by IP. Values are an ascending list of attempt timestamps within
// the window. Pruned on each access.
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetMs: number;
}

/** Increment the IP's bucket. Returns `ok: false` once the cap is hit. */
export function recordAttempt(ip: string): RateLimitResult {
  const key = ip || "unknown";
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const existing = buckets.get(key) ?? [];
  const fresh = existing.filter((t) => t > cutoff);

  if (fresh.length >= MAX_ATTEMPTS) {
    const oldest = fresh[0]!;
    const resetMs = oldest + WINDOW_MS - now;
    buckets.set(key, fresh);
    return { ok: false, remaining: 0, resetMs: Math.max(0, resetMs) };
  }

  fresh.push(now);
  buckets.set(key, fresh);
  return {
    ok: true,
    remaining: MAX_ATTEMPTS - fresh.length,
    resetMs: WINDOW_MS,
  };
}

/**
 * Pull the client IP from the request headers. Vercel forwards through
 * `x-forwarded-for` (comma-separated, leftmost = original client).
 * Falls back to "unknown" when nothing useful is set.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

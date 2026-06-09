// Handle-finder — availability prober.
//
// checkHandleAvailability(handle, platforms) returns a per-platform status:
//   'available' | 'taken' | 'unknown' | 'invalid'.
//
// HONESTY + SAFETY (this is the load-bearing part of the feature):
//   * Format first. A handle that can't exist on a platform is 'invalid' and is
//     NEVER probed — no wasted outbound request, no false signal.
//   * Bluesky uses the REAL public API (com.atproto.identity.resolveHandle): a
//     resolved DID ⇒ taken; an "unable to resolve" ⇒ available. Authoritative.
//   * Every other platform is a BEST-EFFORT HTTP probe of the public profile URL:
//       404 / 410        ⇒ 'available' (signal)
//       200              ⇒ 'taken' (signal)
//       429 / 5xx / block/timeout ⇒ 'unknown' (we do NOT guess)
//     The result is a SIGNAL, not a guarantee — placeholder pages, reserved
//     names, and soft-blocks make a bare status code unreliable. The UI labels
//     it as such and always offers a "Check & claim" link so the user confirms.
//   * Throttled: a global concurrency cap + per-request timeout + a realistic
//     User-Agent keep us from hammering any platform (which would get our egress
//     IP rate-limited or banned). Results are cached upstream (see check.ts), so
//     repeated clicks never re-probe within the TTL.
//
// This module makes NO database calls — the caller (check.ts) layers the cache
// on top. Pure: handle + platforms in, statuses out. Tests stub global fetch.

import type { Channel } from "@/lib/db/types";
import { PLATFORMS, isValidForPlatform, normalizeHandle } from "./platforms";

export type AvailabilityStatus = "available" | "taken" | "unknown" | "invalid";

export interface PlatformAvailability {
  platform: Channel;
  status: AvailabilityStatus;
  // 'bluesky' (authoritative) | 'http' (signal) | 'format' (invalid, no probe).
  source: "bluesky" | "http" | "format";
}

const BSKY_RESOLVE = "https://bsky.social/xrpc/com.atproto.identity.resolveHandle";
const PROBE_TIMEOUT_MS = 8_000;
// Keep outbound fan-out small so we never look like an attack to any platform.
const MAX_CONCURRENCY = 4;
// A real browser UA — many platforms 403 a default fetch/bot UA, which would
// otherwise turn every probe into a false 'unknown'.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// One bounded fetch. Returns null on timeout/network error (→ caller maps to
// 'unknown'); never throws.
async function timedFetch(url: string, method: "GET" | "HEAD"): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Bluesky: authoritative. resolveHandle returns 200 {did} when the handle is
// registered (⇒ taken) and 400 when it can't resolve (⇒ available).
async function probeBluesky(handle: string): Promise<AvailabilityStatus> {
  const full = `${handle}.bsky.social`;
  const res = await timedFetch(`${BSKY_RESOLVE}?handle=${encodeURIComponent(full)}`, "GET");
  if (!res) return "unknown";
  if (res.status === 200) return "taken";
  if (res.status === 400) return "available";
  return "unknown";
}

// Everyone else: best-effort signal off the public profile URL's status code.
async function probeHttp(platform: Channel, handle: string): Promise<AvailabilityStatus> {
  const url = PLATFORMS[platform].profileUrl(handle);
  // GET (not HEAD) — several platforms don't answer HEAD correctly and a wrong
  // method turns into a false signal. redirect:"manual" so a login/redirect to a
  // generic page doesn't read as a real profile.
  const res = await timedFetch(url, "GET");
  if (!res) return "unknown";
  if (res.status === 404 || res.status === 410) return "available";
  if (res.status === 200) return "taken";
  // 3xx (redirect to login/generic), 429 (rate-limited), 5xx, 403 (blocked) →
  // we genuinely don't know. Never guess.
  return "unknown";
}

// Probe a single platform: format-gate, then dispatch by probe kind.
export async function probePlatform(
  handle: string,
  platform: Channel,
): Promise<PlatformAvailability> {
  const normalized = normalizeHandle(handle);
  if (!isValidForPlatform(normalized, platform)) {
    return { platform, status: "invalid", source: "format" };
  }
  const kind = PLATFORMS[platform].probeKind;
  if (kind === "bluesky") {
    return { platform, status: await probeBluesky(normalized), source: "bluesky" };
  }
  return { platform, status: await probeHttp(platform, normalized), source: "http" };
}

// Run an array of async thunks with a fixed concurrency cap (no external dep).
async function pool<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

// Check `handle` across `platforms` (default: all). Throttled to MAX_CONCURRENCY
// outbound requests at a time. No caching here — check.ts adds that.
export async function checkHandleAvailability(
  handle: string,
  platforms: Channel[] = Object.keys(PLATFORMS) as Channel[],
): Promise<PlatformAvailability[]> {
  const thunks = platforms.map((p) => () => probePlatform(handle, p));
  return pool(thunks, MAX_CONCURRENCY);
}

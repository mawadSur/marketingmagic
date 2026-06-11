// Handle-finder — cached availability check (the layer the UI calls).
//
// checkHandleCached(handle, platforms) returns the same per-platform statuses as
// the raw prober, but reads a fresh result from the handle_checks cache first and
// only probes the MISSES. Results are UPSERTed back so the next caller (any
// workspace — the cache is global) is a free hit within the TTL. This is what
// keeps a user spamming "find handles", or many users converging on the same
// obvious handle, from fanning out into duplicate outbound requests that would
// get our egress IP rate-limited.
//
// 'invalid' (format) is computed without any probe and cached too, so a
// structurally-impossible handle never costs a request even once.
//
// Service-role only: handle_checks is locked to the service role (migration 063),
// and the check runs from a server action.

import { supabaseService } from "@/lib/supabase/service";
import type { Channel } from "@/lib/db/types";
import { PLATFORMS, probeIsReliable } from "./platforms";
import {
  checkHandleAvailability,
  type AvailabilityStatus,
  type PlatformAvailability,
} from "./availability";

// How long a cached result is trusted. Availability changes slowly (people don't
// grab-and-drop handles by the minute), and a stale "available" is corrected the
// moment the user clicks through to claim — so a generous TTL is the right
// trade for protecting platform rate limits. 24h.
const TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedAvailability extends PlatformAvailability {
  // True when this row came from the cache (vs. a fresh probe this call).
  cached: boolean;
  // ISO timestamp the underlying result was recorded.
  checkedAt: string;
}

// Check `handle` across `platforms`, cache-first. `now` is injectable for tests.
export async function checkHandleCached(
  handle: string,
  platforms: Channel[] = Object.keys(PLATFORMS) as Channel[],
  now: number = Date.now(),
): Promise<CachedAvailability[]> {
  const svc = supabaseService();
  const nowIso = new Date(now).toISOString();
  const freshCutoff = new Date(now - TTL_MS).toISOString();

  // 1. Read fresh cached rows for this handle.
  const { data: rows } = await svc
    .from("handle_checks")
    .select("platform, status, source, checked_at")
    .eq("handle", handle)
    .gte("checked_at", freshCutoff);

  const cacheByPlatform = new Map<string, { status: AvailabilityStatus; source: string; checked_at: string }>();
  for (const r of rows ?? []) {
    cacheByPlatform.set(r.platform, {
      status: r.status as AvailabilityStatus,
      source: r.source,
      checked_at: r.checked_at,
    });
  }

  // 2. Split hits vs. misses.
  const misses = platforms.filter((p) => !cacheByPlatform.has(p));

  // 3. Probe only the misses (throttled inside checkHandleAvailability).
  const probed = misses.length ? await checkHandleAvailability(handle, misses) : [];

  // 4. Persist the fresh probes (UPSERT — one row per handle+platform).
  if (probed.length) {
    await svc.from("handle_checks").upsert(
      probed.map((p) => ({
        handle,
        platform: p.platform,
        status: p.status,
        source: p.source,
        checked_at: nowIso,
      })),
      { onConflict: "handle,platform" },
    );
  }
  const probedByPlatform = new Map(probed.map((p) => [p.platform, p]));

  // 5. Merge cache + fresh, preserving the requested platform order. `reliable`
  // is derived from the platform's probe kind (not stored — it's a pure function
  // of the platform), so cached rows get the correct flag too.
  return platforms.map((platform): CachedAvailability => {
    const reliable = probeIsReliable(PLATFORMS[platform].probeKind);
    const hit = cacheByPlatform.get(platform);
    if (hit) {
      return {
        platform,
        status: hit.status,
        source: hit.source as PlatformAvailability["source"],
        reliable,
        cached: true,
        checkedAt: hit.checked_at,
      };
    }
    const fresh = probedByPlatform.get(platform);
    return {
      platform,
      status: fresh?.status ?? "unknown",
      source: fresh?.source ?? "cloaked",
      reliable,
      cached: false,
      checkedAt: nowIso,
    };
  });
}

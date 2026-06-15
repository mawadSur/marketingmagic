"use server";

// Public, no-auth handle checker (acquisition Lever 3 — a free top-of-funnel
// tool). A visitor types ONE desired handle → we check it across all 8 platforms
// → return the per-platform availability grid. This is the anonymous twin of the
// in-app onboarding finder (src/app/onboarding/handles), with three differences:
//
//   1. NO auth / workspace. Anyone can hit it (the page is a public SEO surface).
//   2. NO LLM. We never generate names anonymously (cost/abuse) — the AI
//      name-ideas feature is TEASED on the page with a CTA to /start. This action
//      only ever runs the cheap, cached availability probe.
//   3. Per-IP rate limit. The in-app version keys on workspace id; here there's
//      no workspace, so we key on the client IP (reusing the existing in-memory
//      limiter from the /start landing form) on top of the lib's own 24h cache +
//      concurrency cap. Defense in depth: cache → IP cap → throttle.

import { headers } from "next/headers";
import { z } from "zod";
import { checkHandleCached, type CachedAvailability } from "@/lib/handles/check";
import { normalizeHandle, PLATFORM_ORDER } from "@/lib/handles/platforms";
import { recordAttempt, clientIpFromHeaders } from "@/lib/preview/rate-limit";

export type CheckHandleState = {
  error: string | null;
  // The handle we actually checked (normalised), so the result can echo it.
  handle: string | null;
  availability: CachedAvailability[];
};

export const initialCheckState: CheckHandleState = {
  error: null,
  handle: null,
  availability: [],
};

// One name, sane length. The lib normalises + format-gates per platform after
// this, so we only need a coarse bound here to reject obvious abuse/garbage.
const checkSchema = z.object({
  handle: z.string().trim().min(1).max(40),
});

// Check ONE user-typed handle across all platforms (cache-first, throttled). No
// auth, no LLM. Rate-limited per IP via the shared in-memory limiter.
export async function checkPublicHandleAction(
  _prev: CheckHandleState,
  formData: FormData,
): Promise<CheckHandleState> {
  // Per-IP abuse cap (5 / hour, shared limiter). The downstream cost is a
  // bounded, cached, concurrency-capped HTTP probe — never an LLM call — so this
  // plus the lib's 24h cache is sufficient protection for a public tool.
  const hdrs = await headers();
  const ip = clientIpFromHeaders(hdrs);
  const limit = recordAttempt(ip);
  if (!limit.ok) {
    const minutes = Math.max(1, Math.ceil(limit.resetMs / 60_000));
    return {
      error: `You've checked a lot of names. Try again in ~${minutes} minute${minutes === 1 ? "" : "s"} — or sign up free to keep going.`,
      handle: null,
      availability: [],
    };
  }

  const parsed = checkSchema.safeParse({ handle: formData.get("handle") });
  if (!parsed.success) {
    return { error: "Type a name to check (1–40 characters).", handle: null, availability: [] };
  }
  const handle = normalizeHandle(parsed.data.handle);
  if (handle.length < 2) {
    return {
      error: "That name is too short after cleanup — try a few more characters.",
      handle: null,
      availability: [],
    };
  }

  try {
    const availability = await checkHandleCached(handle, PLATFORM_ORDER);
    return { error: null, handle, availability };
  } catch {
    return {
      error: "Something went wrong checking that name. Please try again in a moment.",
      handle,
      availability: [],
    };
  }
}

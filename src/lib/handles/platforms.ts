// Handle-finder — per-platform rules, profile URLs, and signup/claim deep-links.
//
// This is the single source of truth for "what is a valid handle on platform X,
// where does its profile live, and where does a new user go to claim it?" The
// availability prober (availability.ts) and the UI both read from here.
//
// We cover the same eight channels as the channel registry, but this is a
// SEPARATE table on purpose: a handle's format rules + public profile URL are
// orthogonal to the posting registry (maxChars, OAuth, posting windows). Keeping
// them apart means the handle finder doesn't drag the whole posting surface in.
//
// HONESTY NOTE: only Bluesky exposes a real availability API. For every other
// platform `probeKind: "http"` means a best-effort URL probe whose result is a
// SIGNAL, not a guarantee (placeholder pages, reserved names, and soft-blocks
// make a bare 404/200 unreliable). The UI labels it as such; this module never
// pretends an http probe is authoritative.

import type { Channel } from "@/lib/db/types";

// How we determine availability per platform — chosen empirically (we probed
// known-missing vs known-existing handles on each):
//   "bluesky"   — authoritative public API (resolveHandle). Accurate.
//   "http"      — the public profile URL returns a RELIABLE 404-vs-200 split
//                 (YouTube, X). A signal, but a trustworthy one.
//   "tiktok"    — TikTok's oembed JSON endpoint (200=taken, 400=available).
//                 Reliable; the profile HTML 200s for everyone, oembed doesn't.
//   "cloaked"   — the platform returns 200 (or a uniform error) for BOTH a real
//                 and a non-existent handle (Instagram, Threads, Facebook), so a
//                 status-code probe is MEANINGLESS — it would emit false "taken".
//                 We return "unknown" and lean on the user's Claim-link check.
export type ProbeKind = "bluesky" | "http" | "tiktok" | "cloaked";

// Whether a probe kind yields a result a user can trust without re-checking.
// Drives the UI ("verified" vs "best-effort signal" vs "we can't check here").
export function probeIsReliable(kind: ProbeKind): boolean {
  return kind === "bluesky" || kind === "http" || kind === "tiktok";
}

export interface PlatformSpec {
  id: Channel;
  label: string;
  // Min/max handle length the platform enforces.
  minLen: number;
  maxLen: number;
  // Allowed-character matcher for the WHOLE handle (anchored). A candidate that
  // fails this can never exist on the platform, so it's marked "invalid" and
  // never probed.
  pattern: RegExp;
  // Human description of the rule, shown in the UI when a handle is invalid here.
  rule: string;
  // Build the public profile URL for a handle (what the prober GETs / what the
  // user visits). Handle is passed WITHOUT a leading "@".
  profileUrl: (handle: string) => string;
  // Where a new user goes to actually CLAIM the handle (signup or profile). Most
  // platforms don't deep-link a pre-filled username on signup, so we send them
  // to the right place and let them type it — the "one-click claim" affordance.
  claimUrl: (handle: string) => string;
  // How we check availability. "bluesky" = real com.atproto API (accurate);
  // "http" = best-effort profile-URL probe (signal only).
  probeKind: ProbeKind;
}

// Lowercase + strip anything most platforms forbid, so the AI's candidate becomes
// a sane base handle. Per-platform validity is still checked separately (some
// allow dots/dashes, some don't) — this is just the common normalisation.
export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

export const PLATFORMS: Record<Channel, PlatformSpec> = {
  x: {
    id: "x",
    label: "X",
    minLen: 1,
    maxLen: 15,
    // letters, digits, underscore. No dots/dashes.
    pattern: /^[a-z0-9_]{1,15}$/i,
    rule: "1–15 chars: letters, numbers, underscore.",
    profileUrl: (h) => `https://x.com/${h}`,
    claimUrl: () => "https://x.com/i/flow/signup",
    probeKind: "http",
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    minLen: 1,
    maxLen: 30,
    // letters, digits, period, underscore.
    pattern: /^[a-z0-9._]{1,30}$/i,
    rule: "1–30 chars: letters, numbers, period, underscore.",
    profileUrl: (h) => `https://www.instagram.com/${h}/`,
    claimUrl: () => "https://www.instagram.com/accounts/emailsignup/",
    // Cloaked: instagram.com/<handle> returns 200 for BOTH real and missing
    // handles, so a status probe is meaningless (it would emit false "taken").
    probeKind: "cloaked",
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    minLen: 2,
    maxLen: 24,
    // letters, digits, period, underscore.
    pattern: /^[a-z0-9._]{2,24}$/i,
    rule: "2–24 chars: letters, numbers, period, underscore.",
    profileUrl: (h) => `https://www.tiktok.com/@${h}`,
    claimUrl: () => "https://www.tiktok.com/signup",
    // TikTok's profile HTML 200s for everyone, but its oembed JSON endpoint is
    // a reliable signal (200=taken, 400=available) — see availability.ts.
    probeKind: "tiktok",
  },
  threads: {
    id: "threads",
    label: "Threads",
    minLen: 1,
    maxLen: 30,
    // Threads shares the Instagram username namespace + rules.
    pattern: /^[a-z0-9._]{1,30}$/i,
    rule: "Shares your Instagram username (1–30 chars).",
    profileUrl: (h) => `https://www.threads.net/@${h}`,
    claimUrl: () => "https://www.threads.net/login",
    // Cloaked: shares Instagram's infra, same 200-for-everyone behavior.
    probeKind: "cloaked",
  },
  bluesky: {
    id: "bluesky",
    label: "Bluesky",
    // The sub-label portion of <handle>.bsky.social — DNS label rules.
    minLen: 3,
    maxLen: 18,
    pattern: /^[a-z0-9]([a-z0-9-]{1,16})[a-z0-9]$/i,
    rule: "3–18 chars: letters, numbers, dashes (not at the ends).",
    // The full handle is <h>.bsky.social — resolveHandle takes that form.
    profileUrl: (h) => `https://bsky.app/profile/${h}.bsky.social`,
    claimUrl: () => "https://bsky.app",
    probeKind: "bluesky",
  },
  youtube: {
    id: "youtube",
    label: "YouTube",
    minLen: 3,
    maxLen: 30,
    // YouTube @handles: letters, digits, underscore, period, dash.
    pattern: /^[a-z0-9._-]{3,30}$/i,
    rule: "3–30 chars: letters, numbers, period, underscore, dash.",
    profileUrl: (h) => `https://www.youtube.com/@${h}`,
    claimUrl: () => "https://www.youtube.com/account",
    probeKind: "http",
  },
  facebook: {
    id: "facebook",
    label: "Facebook",
    minLen: 5,
    maxLen: 50,
    // FB Page usernames: letters, digits, period. (Min 5 enforced by FB.)
    pattern: /^[a-z0-9.]{5,50}$/i,
    rule: "5–50 chars: letters, numbers, period.",
    profileUrl: (h) => `https://www.facebook.com/${h}`,
    claimUrl: () => "https://www.facebook.com/pages/create",
    // Cloaked: facebook.com/<handle> returns a uniform error/login wall for both
    // real and missing handles — no trustworthy status split.
    probeKind: "cloaked",
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    minLen: 3,
    maxLen: 30,
    // LinkedIn vanity slugs: letters, digits, dashes.
    pattern: /^[a-z0-9-]{3,30}$/i,
    rule: "3–30 chars: letters, numbers, dashes.",
    profileUrl: (h) => `https://www.linkedin.com/company/${h}`,
    claimUrl: () => "https://www.linkedin.com/company/setup/new/",
    // Cloaked: LinkedIn login-walls unauthenticated profile/company requests, so
    // a probe can't distinguish taken from available — don't emit a false signal.
    probeKind: "cloaked",
  },
};

// Stable display order — the "ready today" channels first, mirroring the
// onboarding connect order so the grid feels consistent.
export const PLATFORM_ORDER: Channel[] = [
  "x",
  "instagram",
  "tiktok",
  "youtube",
  "bluesky",
  "threads",
  "facebook",
  "linkedin",
];

// Does `handle` satisfy the platform's format rules? (Already-normalised input
// expected.) A false here means "can't exist on this platform" → never probed.
export function isValidForPlatform(handle: string, platform: Channel): boolean {
  const spec = PLATFORMS[platform];
  if (!spec) return false;
  if (handle.length < spec.minLen || handle.length > spec.maxLen) return false;
  return spec.pattern.test(handle);
}

import crypto from "node:crypto";
import type { Database, VoiceProfile } from "@/lib/db/types";

type BrandBriefsRow = Database["public"]["Tables"]["brand_briefs"]["Row"];

// ─────────────────────────────────────────────────────────────────────────────
// Brief content fingerprint
// ─────────────────────────────────────────────────────────────────────────────
//
// A short, stable hash of the brand-brief fields that actually shape generated
// content — the *inputs* to generatePlan's system prompt. We stamp this into
// every generated post's generation_metadata.brief_fingerprint at insert time,
// then compare it against the workspace's CURRENT fingerprint on the queue. A
// mismatch means "this draft was written against an older brief/voice" → the
// queue offers a one-click regenerate.
//
// Why a content hash and NOT brand_briefs.updated_at:
//   updated_at bumps on ANY column write — including the weekly voice-evolution
//   cron stamping pending_voice_diff, theme-snooze toggles, audience-timezone
//   saves, audio-retention flips. None of those change what the planner reads,
//   so an updated_at comparison would flag every pending draft as "stale" after
//   noise. The fingerprint only moves when a generation-relevant field moves.
//
// Fields included (the exact set planSystemPrompt embeds):
//   product_description, voice, target_audience, do_not_say, reference_links,
//   reference_posts, and the generation-relevant slice of voice_profile.
// Array fields are sorted so a pure reordering (semantically identical to the
// planner) does NOT change the fingerprint.

type BriefLike = Pick<
  BrandBriefsRow,
  | "product_description"
  | "voice"
  | "target_audience"
  | "do_not_say"
  | "reference_links"
  | "reference_posts"
  | "voice_profile"
>;

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
}

// Pull only the voice-profile fields the planner actually renders into the
// prompt (see voiceProfileBlock in plan/prompt.ts). extracted_at + source_count
// are provenance metadata — they move when the profile is re-extracted even if
// the substance is identical, so we exclude them to avoid false "stale" flags.
function canonicalVoiceProfile(
  profile: VoiceProfile | null | undefined,
): Record<string, unknown> | null {
  if (!profile || typeof profile !== "object") return null;
  return {
    vocabulary_signature: (profile.vocabulary_signature ?? "").trim(),
    formality: profile.formality ?? "",
    emoji_usage: profile.emoji_usage ?? "",
    // Round so a sub-unit drift (re-extraction noise) doesn't churn the hash.
    sentence_length_avg:
      typeof profile.sentence_length_avg === "number"
        ? Math.round(profile.sentence_length_avg)
        : 0,
    summary: (profile.summary ?? "").trim(),
    opener_patterns: sortedStrings(profile.opener_patterns),
    signature_phrases: sortedStrings(profile.signature_phrases),
    punctuation_quirks: sortedStrings(profile.punctuation_quirks),
    do_not_say: sortedStrings(profile.do_not_say),
  };
}

/**
 * Stable 16-hex-char fingerprint of the generation-relevant brief content.
 * Pure + deterministic — same content always yields the same string, and the
 * field ordering here is fixed so it never depends on object-key iteration.
 */
export function briefContentFingerprint(brief: BriefLike | null | undefined): string {
  const canonical = {
    product_description: (brief?.product_description ?? "").trim(),
    voice: (brief?.voice ?? "").trim(),
    target_audience: (brief?.target_audience ?? "").trim(),
    do_not_say: sortedStrings(brief?.do_not_say),
    reference_links: sortedStrings(brief?.reference_links),
    reference_posts: sortedStrings(brief?.reference_posts),
    voice_profile: canonicalVoiceProfile(brief?.voice_profile),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Read the brief_fingerprint a post was stamped with at generation time.
 * Returns null for posts that predate fingerprinting or were hand-composed
 * (no brief input) — those are intentionally never treated as "stale".
 */
export function postBriefFingerprint(generationMetadata: unknown): string | null {
  if (!generationMetadata || typeof generationMetadata !== "object") return null;
  const fp = (generationMetadata as { brief_fingerprint?: unknown }).brief_fingerprint;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

/**
 * A pending post is "stale" when it carries a brief_fingerprint that differs
 * from the workspace's current fingerprint. Posts without a stamped fingerprint
 * are NOT stale (we can't know which brief they used, so we never auto-rewrite
 * them — conservative by design).
 */
export function isPostStaleForBrief(
  generationMetadata: unknown,
  currentFingerprint: string,
): boolean {
  const stamped = postBriefFingerprint(generationMetadata);
  return stamped !== null && stamped !== currentFingerprint;
}

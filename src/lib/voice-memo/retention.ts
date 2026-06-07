// Voice-memo audio retention policy (Phase 2.6).
//
// Single source of truth for the retention WINDOW and the expiry rule. The
// preference itself is brand_briefs.audio_retention_opt_in (migration 050):
//
//   false (default) → raw audio is NEVER persisted. transcribeRecordingAction
//                     skips the Storage upload entirely and the bytes are
//                     discarded after the Groq round-trip. "Delete immediately
//                     after transcription" is enforced by simply never writing
//                     the blob — there is nothing to clean up.
//   true            → the blob is uploaded to the private `founder-audio`
//                     Storage bucket and must be deleted after 30 days.
//
// Two enforcement layers for the opt-IN (30-day) case:
//   1. Storage-bucket lifecycle (operator-configured in the Supabase
//      dashboard — buckets are dashboard-managed in this project; see the
//      015 + 050 migration headers). This is the backstop.
//   2. An application-side sweep cron (see TODO below) so retention is
//      enforced even if the bucket lifecycle is misconfigured, and so the
//      sources.file_path pointer can be nulled in the same pass.

export const AUDIO_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Pure: has a retained audio object aged past the retention window? Used by
// the sweep cron (below, TODO) to decide what to delete. `now` is injectable
// so this is deterministically testable.
export function isAudioExpired(uploadedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - uploadedAt.getTime();
  return ageMs >= AUDIO_RETENTION_DAYS * MS_PER_DAY;
}

// TODO(voice-memo retention cron): wire an /api/cron/audio-retention route
// (+ a vercel.json crons entry, e.g. daily "0 4 * * *") that, with the
// service-role client:
//   1. Lists objects in the `founder-audio` bucket.
//   2. Deletes every object whose created_at is isAudioExpired(...).
//   3. Nulls sources.file_path for any sources row pointing at a deleted
//      object (so the /record + sources UIs stop advertising a vault file
//      that no longer exists).
// Until then, the bucket lifecycle policy (operator-configured to 30 days)
// is the live enforcement; this app-side sweep is the belt-and-braces layer.
// Tracked as the only remaining Phase-2.6 follow-up.

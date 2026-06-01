// Shared errors for the per-channel social publishers.
//
// RetryableError signals a TRANSIENT failure that should NOT mark a scheduled
// post permanently `failed`. The canonical case is async video transcode: the
// platform (Facebook/Threads/IG/Bluesky/X/LinkedIn) accepts the upload and
// transcodes on its side, and our bounded poll runs out of time budget before
// the platform reaches a terminal state. Throwing this instead of a plain Error
// lets the post-scheduled cron leave the post in `scheduled` state so the next
// cron tick retries — the platform's transcode keeps making progress in the
// background, and a later poll finds it `ready`.
//
// Contrast with a plain Error (e.g. an HTTP 4xx, an explicit `status=error`
// from the platform, or a mixed-media validation failure): those are terminal
// and SHOULD fail the post so the user is told.
//
// Hardening path (documented, not built in P3): persist the platform's
// transcode handle (video id / container id / job id) on the post row at upload
// time, and on a later tick resume polling that handle instead of re-uploading
// the bytes. That turns "retry the whole upload" into "resume the existing
// transcode", eliminating duplicate uploads for a single slow render.
export class RetryableError extends Error {
  // Marker the cron checks (alongside `instanceof`) so a future serialization
  // boundary — e.g. an error round-tripped through a queue — can still be
  // recognised as retryable.
  readonly retryable = true as const;

  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

// True for any error the publisher considers transient — used by the cron to
// decide between "leave scheduled, retry next tick" and "mark failed".
export function isRetryableError(err: unknown): err is RetryableError {
  return (
    err instanceof RetryableError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { retryable?: unknown }).retryable === true)
  );
}

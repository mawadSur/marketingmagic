import * as Sentry from "@sentry/nextjs";

// Edge runtime Sentry instrumentation (fallback for Next.js versions that don't
// auto-import instrumentation.ts). Initializes ONLY when SENTRY_DSN is set; when
// absent, this is a no-op (graceful-degrade).
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // autoSessionTracking is not supported on edge runtime.
    beforeSend(event, hint) {
      if (process.env.NODE_ENV !== "production") return null;
      return event;
    },
  });
}

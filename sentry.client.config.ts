import * as Sentry from "@sentry/nextjs";

// Client-side Sentry instrumentation. Initializes ONLY when NEXT_PUBLIC_SENTRY_DSN
// is set; when absent, this is a no-op (graceful-degrade) so the app boots without
// error monitoring. The DSN is public (client bundle) but the project itself guards
// writes via an allowlist.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Lower sample rate on client to reduce quota burn from one-off network flakes
    // and browser-extension noise.
    tracesSampleRate: 0.05,
    // Replay sessions on error. Disabled by default to preserve privacy; enable
    // once the team wants session replay for debugging.
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 0.0,
    beforeSend(event, hint) {
      // Drop noise: browser extension injections, local dev.
      if (process.env.NODE_ENV !== "production") return null;
      // Filter known noisy browser errors (ResizeObserver loop, unhandled rejections
      // from third-party scripts injected by extensions).
      const message = event.message || "";
      if (message.includes("ResizeObserver")) return null;
      return event;
    },
  });
}

import * as Sentry from "@sentry/nextjs";

// Node.js runtime instrumentation (server actions, API routes, server components
// running on Node.js). Sentry initializes ONLY when SENTRY_DSN is set; when absent,
// this is a no-op (graceful-degrade) so the app boots without error monitoring.
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Mirrors the current Anthropic retry strategy (maxRetries: 6) — capture both
    // transient errors (flake) and durable errors (bugs) but don't spam the quota
    // on ephemeral network noise.
    tracesSampleRate: 0.1,
    // When production, prioritize signal-to-noise by filtering known noise.
    beforeSend(event, hint) {
      // Drop noise: Next.js dev HMR connection churn, local build warnings.
      if (process.env.NODE_ENV !== "production") return null;
      return event;
    },
  });
}

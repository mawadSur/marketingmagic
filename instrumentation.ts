// Edge runtime instrumentation (server components + middleware).
// Sentry auto-imports this via Next.js's `register()` hook when the Next.js
// version is 15+. For Next 16.0.0 this is the correct path.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./instrumentation-edge");
  }
}

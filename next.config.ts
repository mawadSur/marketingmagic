import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },
  async redirects() {
    return [
      {
        // Our LinkedIn OAuth app (and potentially other consoles) registered the
        // privacy-policy URL as /policy, but the route lives at /privacy. Without
        // this redirect that URL 404s — which both looks broken on the OAuth
        // consent screen and is a known cause of LinkedIn graying out product
        // "Request access". 308 permanent so validators/crawlers follow it.
        source: "/policy",
        destination: "/privacy",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            // CSP report-only mode. This does NOT enforce; it LOGS violations so we
            // can spot breakage before flipping to enforcing mode. The policy covers
            // the app's known dependencies:
            //   - Next.js inline scripts (unsafe-inline + script hashes)
            //   - Vercel Analytics (va.vercel-scripts.com)
            //   - Supabase (*.supabase.co)
            //   - Anthropic (api.anthropic.com)
            //   - fal.ai (fal.run, queue.fal.run)
            //   - Stripe (js.stripe.com, checkout.stripe.com)
            //   - Social OAuth domains (facebook.com, twitter.com, x.com, linkedin.com,
            //     bsky.app, tiktok.com, youtube.com, googleapis.com)
            //
            // NEXT STEPS:
            //   1. Deploy, watch for CSP reports in Sentry/logs.
            //   2. Once clean (no violations for 1 week), flip to enforcing:
            //      rename this header key from "Content-Security-Policy-Report-Only"
            //      to "Content-Security-Policy".
            //   3. Tighten unsafe-inline by capturing Next.js script hashes via
            //      the @next/csp integration once the CSP is stable.
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' va.vercel-scripts.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co https://api.anthropic.com https://fal.run https://queue.fal.run https://js.stripe.com https://checkout.stripe.com wss://*.supabase.co https://www.facebook.com https://graph.facebook.com https://twitter.com https://x.com https://api.x.com https://api.linkedin.com https://www.linkedin.com https://bsky.app https://bsky.social https://www.tiktok.com https://open-api.tiktok.com https://www.youtube.com https://www.googleapis.com",
              "frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://www.facebook.com https://twitter.com https://x.com https://www.linkedin.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self' https://www.facebook.com https://twitter.com https://x.com https://www.linkedin.com https://bsky.app https://www.tiktok.com https://accounts.google.com",
              "frame-ancestors 'self'",
            ]
              .join("; ")
              .replace(/\s+/g, " "),
          },
        ],
      },
    ];
  },
};

// Wrap the config with Sentry. The build plugin uploads source maps when
// SENTRY_AUTH_TOKEN is set; when absent, the plugin is a no-op (build still
// succeeds, but source maps aren't uploaded). This lets local/CI builds work
// without the token — only production deployments need it for full error context.
const sentryWebpackPluginOptions = {
  // Only upload source maps when the auth token is set. This prevents build
  // failures in local/CI environments where the token is absent.
  silent: !process.env.SENTRY_AUTH_TOKEN,
  dryRun: !process.env.SENTRY_AUTH_TOKEN,
  // Disable all Sentry features during build when the DSN is unset (Sentry
  // is intentionally unconfigured). This ensures zero overhead when error
  // monitoring is off.
  disableServerWebpackPlugin: !process.env.SENTRY_DSN,
  disableClientWebpackPlugin: !process.env.NEXT_PUBLIC_SENTRY_DSN,
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);

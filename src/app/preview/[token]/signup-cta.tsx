"use client";

import Link from "next/link";
import { track } from "@vercel/analytics";

// Tiny client component whose only job is to (1) render the signup CTA
// and (2) fire a Vercel Analytics custom event on click. We hand-off the
// `from=preview` query param so the signup route can attribute conversions
// to the Magic Moment funnel.

export function SignupCtaLink({
  token,
  channel,
  handleHash,
  variant = "secondary",
}: {
  token: string;
  channel: string;
  handleHash: string;
  variant?: "primary" | "secondary";
}) {
  const cls =
    variant === "primary"
      ? "inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
      : "inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent";

  // Carry an opaque truncated token reference through to signup so the
  // signup route can correlate visits without keeping the full token in
  // the new URL (avoids leaking the full plan via referrer headers).
  const href = `/signup?from=preview&t=${encodeURIComponent(token.slice(0, 24))}`;

  return (
    <Link
      href={href}
      className={cls}
      onClick={() => {
        try {
          track("mm_preview_signup_cta", {
            channel,
            handle_hash: handleHash,
          });
        } catch {
          /* never break the user flow on analytics failure */
        }
      }}
    >
      Sign up to keep this plan
    </Link>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";

// Suppressed where the call-to-action would be a tautology: the user is
// already on a page whose entire job is to connect a channel.
const HIDE_PREFIXES = ["/settings/channels", "/onboarding"];

export function NoChannelsBanner() {
  const pathname = usePathname() ?? "";
  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="container flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            No channels connected yet — we can&apos;t publish posts until you connect at least one.
          </span>
        </div>
        <Link
          href="/settings/channels"
          className="font-medium underline-offset-4 hover:underline"
        >
          Connect a channel →
        </Link>
      </div>
    </div>
  );
}

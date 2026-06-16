"use client";

// The per-platform action on a handle-availability result. The hard truth: we
// can't create the account for the user (every platform requires them to finish
// signup themselves), so the best we can do is make the manual claim one click:
//
//   • verified-TAKEN  → "View" the live profile (see who has it)
//   • everything else → "Claim" → opens that platform's signup/create page
//     (spec.claimUrl) AND copies the handle to the clipboard, because signup
//     URLs can't pre-fill the username — so the user just pastes it. After a
//     click the cell flips to a "✓ Copied" marker, which doubles as a
//     lightweight per-platform claim checklist for the session.
import { useState } from "react";
import { ExternalLink, Check } from "lucide-react";
import { PLATFORMS } from "@/lib/handles/platforms";
import type { PlatformAvailability } from "@/lib/handles/availability";

export function HandleClaimAction({
  platform,
  handle,
  status,
  reliable,
  size = "sm",
}: {
  platform: PlatformAvailability["platform"];
  handle: string;
  status: string;
  reliable: boolean;
  size?: "sm" | "xs";
}) {
  const spec = PLATFORMS[platform];
  const [copied, setCopied] = useState(false);

  if (status === "invalid") return null;

  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  const icon = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3";
  const base = `inline-flex shrink-0 items-center gap-0.5 rounded ${text} font-medium underline-offset-2`;

  // Verified taken → just let them look at who holds it.
  if (reliable && status === "taken") {
    return (
      <a
        href={spec.profileUrl(handle)}
        target="_blank"
        rel="noopener noreferrer"
        className={`${base} text-muted-foreground hover:text-foreground hover:underline`}
        title={`View who has @${handle} on ${spec.label}`}
      >
        View
        <ExternalLink className={icon} aria-hidden />
      </a>
    );
  }

  // Available (or cloaked "check it") → claim. Copy the handle, open signup.
  return (
    <a
      href={spec.claimUrl(handle)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => {
        // Fire-and-forget; clipboard may be unavailable (insecure context) —
        // the signup page still opens either way.
        void navigator.clipboard?.writeText(handle).catch(() => {});
        setCopied(true);
      }}
      className={
        copied
          ? `${base} text-emerald-600 dark:text-emerald-400`
          : `${base} text-primary hover:underline`
      }
      title={`Claim @${handle} on ${spec.label} — we'll copy the handle so you just paste it`}
    >
      {copied ? (
        <>
          <Check className={icon} aria-hidden />
          Copied
        </>
      ) : (
        <>
          Claim
          <ExternalLink className={icon} aria-hidden />
        </>
      )}
    </a>
  );
}

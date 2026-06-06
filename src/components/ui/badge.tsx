import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge — small status/category pill. Replaces the loose
 * `rounded-md border px-2 py-0.5 text-xs uppercase` strings that were
 * scattered across the app.
 *
 * Channel-specific tints (X/LinkedIn/Threads/Instagram/Bluesky) are
 * applied via the <ChannelBadge> helper, not this base component.
 */

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
  {
    variants: {
      variant: {
        // Neutral outline — the default look across the app.
        default: "border-border bg-background text-foreground/80",
        // Subdued muted background for low-emphasis labels.
        muted: "border-transparent bg-muted text-muted-foreground",
        // Status colours, driven by the --success / --warning tokens so the
        // shades live in one place and read in both light and dark.
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/20 bg-warning/10 text-warning",
        danger:
          "border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive",
        info: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-400",
      },
      size: {
        default: "text-[10px]",
        sm: "px-1.5 py-0.5 text-[10px]",
        md: "text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

/**
 * Map a post status string (`pending_approval`, `scheduled`, `posted`,
 * `failed`, `rejected`, `revoked`, `draft`, `active`, …) to a Badge variant.
 */
export function statusBadgeVariant(status: string): BadgeProps["variant"] {
  const s = status.toLowerCase();
  if (s === "posted" || s === "active" || s === "connected") return "success";
  if (s === "scheduled" || s === "pending_approval" || s === "pending") return "info";
  if (s === "failed" || s === "rejected" || s === "revoked" || s === "disconnected")
    return "danger";
  if (s === "draft" || s === "paused") return "muted";
  return "default";
}

/** Friendlier label for snake_case statuses. */
export function statusBadgeLabel(status: string): string {
  return status.replace(/_/g, " ");
}

// --- Channel badge -----------------------------------------------------------

const CHANNEL_LABEL: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  instagram: "Instagram",
  facebook: "Facebook",
  bluesky: "Bluesky",
  tiktok: "TikTok",
};

// Per-channel tint. Picked so each brand reads at a glance without
// overpowering the page. Kept as Tailwind arbitrary classes (no extra
// CSS, no external assets).
const CHANNEL_STYLE: Record<string, string> = {
  x: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  linkedin: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  threads: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  instagram: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-400",
  facebook: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  bluesky: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  tiktok: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

export function ChannelBadge({
  channel,
  size = "default",
  className,
}: {
  channel: string;
  size?: BadgeProps["size"];
  className?: string;
}) {
  const style = CHANNEL_STYLE[channel] ?? CHANNEL_STYLE.x;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        size === "md" && "text-xs",
        style,
        className,
      )}
    >
      {channelLabel(channel)}
    </span>
  );
}

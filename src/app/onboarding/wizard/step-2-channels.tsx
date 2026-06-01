"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ChannelOption {
  slug: "facebook" | "bluesky" | "threads" | "x" | "linkedin" | "instagram";
  label: string;
  description: string;
  // Shown as a small tag. "ready" = publishes today; "setup" = needs an extra
  // account/approval step before it can post. Ordering below puts the
  // ready-today channels first so a new user hits a guaranteed win.
  badge?: "ready" | "setup";
}

const CHANNELS: ChannelOption[] = [
  {
    slug: "facebook",
    label: "Facebook",
    description: "Post to your Pages. One-click OAuth — live and ready.",
    badge: "ready",
  },
  {
    slug: "bluesky",
    label: "Bluesky",
    description: "AT Protocol. Uses an app password — not your main login.",
    badge: "ready",
  },
  {
    slug: "threads",
    label: "Threads",
    description: "Meta's short-form network. One-click OAuth.",
    badge: "ready",
  },
  {
    slug: "x",
    label: "X",
    description: "Short-form posts. One-click OAuth (manual key paste available).",
    badge: "ready",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    description: "Long-form professional. OAuth — no passwords to manage.",
    badge: "ready",
  },
  {
    slug: "instagram",
    label: "Instagram",
    description: "Captions paired with images. OAuth; business/creator account required.",
    badge: "setup",
  },
];

interface Step2Props {
  connectedChannels: string[];
  /** From `?connected=<slug>` after a successful OAuth round-trip. */
  justConnected: string | null;
}

/**
 * Step 2: a card grid of the supported channels, ready-to-publish ones first
 * so a new user hits a guaranteed win (Facebook/Bluesky/Threads/X/LinkedIn)
 * before the setup-gated one (Instagram). Each card links to that
 * channel's existing settings page. Connection state is read from the DB
 * (passed in by the server page), so connecting via any flow — OAuth, X paste,
 * Bluesky app password — lights up the right card on return.
 */
export function Step2Channels({ connectedChannels, justConnected }: Step2Props) {
  const router = useRouter();
  const connected = new Set(connectedChannels);
  const hasAny = connected.size > 0;

  return (
    <div className="space-y-6">
      {justConnected ? (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <p>
            <span className="font-medium capitalize">{justConnected}</span> connected. Add another or
            continue.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {CHANNELS.map((c) => {
          const isConnected = connected.has(c.slug);
          return (
            <Card
              key={c.slug}
              className={isConnected ? "border-emerald-500/40 bg-emerald-500/5" : undefined}
            >
              <CardContent className="flex h-full flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium leading-none">{c.label}</h3>
                    {!isConnected && c.badge ? (
                      <span
                        className={
                          c.badge === "ready"
                            ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400"
                            : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                        }
                      >
                        {c.badge === "ready" ? "Ready" : "Setup"}
                      </span>
                    ) : null}
                  </div>
                  {isConnected ? (
                    <CheckCircle2
                      className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-label="Connected"
                    />
                  ) : null}
                </div>
                <p className="flex-1 text-xs text-muted-foreground">{c.description}</p>
                <Link
                  href={`/settings/channels/${c.slug}?from=wizard`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {isConnected ? "Reconnect" : "Connect"}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-2 pt-2">
        <Button
          type="button"
          size="lg"
          className="w-full sm:w-auto sm:min-w-[260px]"
          disabled={!hasAny}
          onClick={() => router.push("/onboarding/wizard?step=3")}
        >
          {hasAny ? "Continue to plan" : "Connect at least one channel"}
        </Button>
        {!hasAny ? (
          <p className="text-xs text-muted-foreground">
            We need somewhere to post. You can always add more later.
          </p>
        ) : null}
      </div>
    </div>
  );
}

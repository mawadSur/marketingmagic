"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ChannelOption {
  slug: "x" | "linkedin" | "threads" | "instagram" | "bluesky";
  label: string;
  description: string;
}

const CHANNELS: ChannelOption[] = [
  {
    slug: "x",
    label: "X",
    description: "Short-form posts. Manual API-key paste — keys stay server-side.",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    description: "Long-form professional. OAuth — no passwords to manage.",
  },
  {
    slug: "threads",
    label: "Threads",
    description: "Meta's short-form network. OAuth.",
  },
  {
    slug: "instagram",
    label: "Instagram",
    description: "Captions paired with images. OAuth, business account required.",
  },
  {
    slug: "bluesky",
    label: "Bluesky",
    description: "AT Protocol. Uses an app password — not your main login.",
  },
];

interface Step2Props {
  connectedChannels: string[];
  /** From `?connected=<slug>` after a successful OAuth round-trip. */
  justConnected: string | null;
}

/**
 * Step 2: a card grid of the five supported channels. Each card links to
 * that channel's existing settings page. Connection state is read from
 * the DB (passed in by the server page), so connecting via any flow —
 * OAuth, X paste, Bluesky app password — lights up the right card on
 * return.
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
                  <div className="space-y-0.5">
                    <h3 className="font-medium leading-none">{c.label}</h3>
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

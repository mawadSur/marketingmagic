"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, Sparkles, Link2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { HandleFinder } from "../handles/handle-finder";

interface ChannelOption {
  slug: "facebook" | "bluesky" | "threads" | "x" | "linkedin" | "instagram";
  label: string;
  description: string;
  // Shown as a small tag. "ready" = publishes today; "setup" = needs an extra
  // account/approval step before it can post; "soon" = awaiting external
  // platform approval (see `comingSoon`). Ordering below puts the ready-today
  // channels first so a new user hits a guaranteed win.
  badge?: "ready" | "setup" | "soon";
  // Awaiting platform approval (e.g. LinkedIn's Community Management API
  // review), so connecting would dead-end on a provider error. Rendered as a
  // disabled card with a "Coming soon" tag — never a live connect — to stay in
  // sync with settings/channels (CONNECTORS[].comingSoon). Flip off once approved.
  comingSoon?: boolean;
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
    description: "Long-form professional. Awaiting LinkedIn's Community Management API approval.",
    badge: "soon",
    comingSoon: true,
  },
  {
    slug: "instagram",
    label: "Instagram",
    description: "Captions paired with images. OAuth; business/creator account required.",
    badge: "setup",
  },
];

// The two ways a new user can answer "where do you want to post?": connect an
// account they already have, or — if they don't have one yet — find + claim a
// brandable handle first. A founder mid-launch often has SOME but not all, so
// the toggle lets them flip between the two freely without leaving the step.
type Mode = "connect" | "find";

interface Step2Props {
  connectedChannels: string[];
  /** From `?connected=<slug>` after a successful OAuth round-trip. */
  justConnected: string | null;
}

/**
 * Step 2: connect channels — or find handles for the ones you don't have yet.
 *
 * A segmented toggle switches between two inline views:
 *   • "I have accounts" → the channel card grid (ready-to-publish first, so a
 *     new user hits a guaranteed win). Coming-soon channels render disabled.
 *   • "Find me handles" → the handle finder mounts INLINE (no page jump), so a
 *     user who isn't on a platform yet can claim a free username and come back.
 *
 * Connection state is read from the DB (passed in by the server page), so
 * connecting via any flow — OAuth, X paste, Bluesky app password — lights up the
 * right card on return. We default to whichever view fits: a brand-new user with
 * zero connections lands on "Find me handles"; everyone else on "Connect".
 */
export function Step2Channels({ connectedChannels, justConnected }: Step2Props) {
  const router = useRouter();
  const connected = new Set(connectedChannels);
  const hasAny = connected.size > 0;
  // Lead with the Connect grid for everyone. Connecting an existing account is
  // the activation-critical action, and our ICP (build-in-public founders) already
  // have socials — a 0-channel user landing on "Find me handles" (the old default)
  // was the single biggest connect-step drop in dogfooding. The handle finder is
  // still one toggle away for the rare account-less user.
  const [mode, setMode] = useState<Mode>("connect");

  // Connectable (non-coming-soon) channels, for the "X of N connected" hint.
  const connectableTotal = CHANNELS.filter((c) => !c.comingSoon).length;
  const connectedCount = CHANNELS.filter((c) => !c.comingSoon && connected.has(c.slug)).length;

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

      {/* Segmented toggle: connect what you have vs. find what you're missing. */}
      <div className="space-y-2">
        <div
          className="mx-auto grid w-full max-w-md grid-cols-2 gap-1 rounded-xl border bg-muted/40 p-1"
          role="tablist"
          aria-label="Connect an account or find a new handle"
        >
          <SegmentButton
            active={mode === "connect"}
            onClick={() => setMode("connect")}
            icon={Link2}
          >
            I have accounts
          </SegmentButton>
          <SegmentButton
            active={mode === "find"}
            onClick={() => setMode("find")}
            icon={Sparkles}
            accent
          >
            Find me handles
          </SegmentButton>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          {mode === "connect"
            ? "Connect the accounts you already have."
            : "Not on a platform yet? Claim a name that's free everywhere — then come back to connect."}
        </p>
      </div>

      {mode === "connect" ? (
        <ConnectGrid
          connected={connected}
          connectedCount={connectedCount}
          connectableTotal={connectableTotal}
          onFindHandles={() => setMode("find")}
        />
      ) : (
        <FindHandlesPanel onDone={() => setMode("connect")} />
      )}

      {mode === "connect" ? (
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
      ) : null}
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  icon: Icon,
  accent,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Link2;
  // The "find" tab gets a brand-tinted icon so the discovery path draws the eye.
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon
        className={cn("h-4 w-4", accent ? "text-primary" : undefined)}
        aria-hidden
      />
      {children}
    </button>
  );
}

function ConnectGrid({
  connected,
  connectedCount,
  connectableTotal,
  onFindHandles,
}: {
  connected: Set<string>;
  connectedCount: number;
  connectableTotal: number;
  onFindHandles: () => void;
}) {
  return (
    <div className="space-y-3">
      {connectedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {connectedCount} of {connectableTotal}
          </span>{" "}
          connected.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {CHANNELS.map((c) => {
          const isConnected = connected.has(c.slug);
          // Awaiting platform approval (LinkedIn CMA review): show the card but
          // never a live connect — connecting would dead-end on a provider
          // error. Mirrors the disabled "Coming soon" tile in settings/channels.
          const comingSoon = Boolean(c.comingSoon) && !isConnected;
          return (
            <Card
              key={c.slug}
              className={
                isConnected
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : comingSoon
                    ? "opacity-60"
                    : undefined
              }
              aria-disabled={comingSoon || undefined}
              title={comingSoon ? "Awaiting platform approval" : undefined}
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
                        {c.badge === "ready" ? "Ready" : c.badge === "soon" ? "Coming soon" : "Setup"}
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
                {comingSoon ? (
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
                    Coming soon
                  </span>
                ) : (
                  <Link
                    href={`/settings/channels/${c.slug}?from=wizard`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {isConnected ? "Reconnect" : "Connect"}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Gentle nudge for the user who's missing a platform — flips to the
          finder without leaving the step. */}
      <button
        type="button"
        onClick={onFindHandles}
        className="flex w-full items-center gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/[0.03] px-4 py-3 text-left text-sm transition-colors hover:bg-primary/[0.07]"
      >
        <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <span className="flex-1">
          <span className="font-medium">Missing one?</span>{" "}
          <span className="text-muted-foreground">
            Find a handle that&apos;s free across every platform — and claim it in one click.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      </button>
    </div>
  );
}

function FindHandlesPanel({ onDone }: { onDone: () => void }) {
  return (
    <div className="space-y-6">
      {/* Brand-gradient intro band — makes the discovery path feel like a first-
          class part of the wizard, not a detour. */}
      <div className="overflow-hidden rounded-2xl border">
        <div className="brand-gradient px-5 py-4 text-white">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-semibold">One name, everywhere you post.</p>
              <p className="text-xs text-white/85">
                We&apos;ll suggest brandable usernames from your brief and show where each one is
                still free. Already on a few platforms? Just claim the ones you&apos;re missing.
              </p>
            </div>
          </div>
        </div>
        <div className="bg-card p-5">
          <HandleFinder />
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 pt-2">
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="w-full sm:w-auto sm:min-w-[260px]"
          onClick={onDone}
        >
          <Link2 className="mr-1.5 h-4 w-4" aria-hidden />
          I&apos;ve got my accounts — connect them
        </Button>
        <p className="text-xs text-muted-foreground">
          Claimed your handles? Sign up on each platform, then connect them here.
        </p>
      </div>
    </div>
  );
}

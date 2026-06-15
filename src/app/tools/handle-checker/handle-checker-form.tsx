"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  Search,
  Check,
  X,
  HelpCircle,
  Ban,
  ExternalLink,
  AlertCircle,
  Lock,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { PLATFORMS } from "@/lib/handles/platforms";
import type { AvailabilityStatus, PlatformAvailability } from "@/lib/handles/availability";
import {
  checkPublicHandleAction,
  initialCheckState,
  type CheckHandleState,
} from "./actions";

// The interactive heart of the public tool: a single input → availability grid.
// No auth, no LLM — the AI name-ideas feature is teased (locked card) with a CTA
// to /start. Styling mirrors the public marketing surface (homepage/pricing),
// not the app-internal UI.
export function HandleCheckerForm() {
  const [state, action, pending] = useActionState(checkPublicHandleAction, initialCheckState);
  const hasResult = state.handle && state.availability.length > 0;

  return (
    <div className="space-y-8">
      {/* Search box */}
      <form action={action} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            id="handle"
            name="handle"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="yourbrand"
            maxLength={40}
            aria-label="Desired handle or brand name"
            className="h-12 w-full rounded-xl border bg-background pl-9 pr-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-12 items-center justify-center gap-1.5 rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
        >
          <Search className="h-4 w-4" aria-hidden />
          {pending ? "Checking…" : "Check availability"}
        </button>
      </form>

      {state.error ? (
        <div className="flex items-start gap-1.5 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{state.error}</p>
        </div>
      ) : null}

      {hasResult ? (
        <ResultGrid handle={state.handle!} availability={state.availability} />
      ) : null}

      {/* AI name-ideas tease — NEVER generated anonymously (cost/abuse). Locked
          card with a CTA to signup. This is the conversion hook of the tool. */}
      <AiIdeasTease show={Boolean(hasResult)} />
    </div>
  );
}

function ResultGrid({
  handle,
  availability,
}: {
  handle: string;
  availability: CheckHandleState["availability"];
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold">
          Results for <span className="brand-gradient-text">@{handle}</span>
        </p>
        <p className="text-xs text-muted-foreground">8 platforms checked</p>
      </div>

      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {availability.map((a) => (
          <PlatformCell key={a.platform} a={a} handle={handle} />
        ))}
      </ul>

      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">Available</span> /{" "}
        <span className="font-medium text-destructive">Taken</span> are verified on Bluesky,
        TikTok, YouTube and X. Instagram, Threads, Facebook and LinkedIn hide this from outside
        checks, so we show <span className="font-medium text-sky-600 dark:text-sky-400">Check →</span>{" "}
        — one tap confirms it on the platform. Results are a best-effort signal, not a guarantee.
      </p>
    </div>
  );
}

function PlatformCell({ a, handle }: { a: PlatformAvailability; handle: string }) {
  const spec = PLATFORMS[a.platform];
  // Cloaked platforms report 'unknown' with reliable=false — render a neutral
  // "Check it yourself" cell, never a misleading amber "Unknown". Reliable
  // results keep their green/red/grey tone. (Same honesty contract as the
  // in-app finder.)
  const t = a.reliable ? tone(a.status) : CHECK_TONE;
  const href =
    a.reliable && a.status === "taken" ? spec.profileUrl(handle) : spec.claimUrl(handle);
  const linkLabel = a.reliable && a.status === "taken" ? "View" : "Check";

  return (
    <li
      className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${t.border} ${t.bg}`}
    >
      <t.Icon className={`h-4 w-4 shrink-0 ${t.text}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{spec.label}</span>
        <span className={`block text-[11px] ${t.text}`}>{t.label}</span>
      </span>
      {a.status !== "invalid" ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 rounded text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title={
            linkLabel === "View"
              ? `View who has @${handle} on ${spec.label}`
              : `Check & claim @${handle} on ${spec.label}`
          }
        >
          {linkLabel}
          <ExternalLink className="h-2.5 w-2.5" aria-hidden />
        </a>
      ) : null}
    </li>
  );
}

// The locked AI feature. We do NOT call an LLM anonymously — this card is a
// blurred/locked tease that converts to signup. Slightly more prominent once
// the visitor has seen a result (they're warm).
function AiIdeasTease({ show }: { show: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-6">
      {/* Blurred faux suggestions behind the lock — signals "there's more here". */}
      <div aria-hidden className="pointer-events-none absolute inset-0 select-none opacity-40 blur-sm">
        <div className="flex flex-col gap-2 p-6 pt-16">
          {["@brightwavehq", "@getloomly", "@northpeak.co", "@usevelvet"].map((h) => (
            <div key={h} className="flex items-center justify-between rounded-lg border bg-background/60 px-3 py-2">
              <span className="text-sm font-medium">{h}</span>
              <span className="text-[11px] text-emerald-600">Available on 6/8</span>
            </div>
          ))}
        </div>
      </div>

      <div className="relative flex flex-col items-start gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Locked
        </span>
        <h3 className="text-lg font-semibold sm:text-xl">
          Get AI name ideas tailored to your brand
        </h3>
        <p className="max-w-md text-sm text-muted-foreground">
          Tell us what you do and we&apos;ll generate brandable usernames that are actually
          available across the platforms — then claim them in one place.
          {show ? " Your check is a great start; the ideas pick up from here." : ""}
        </p>
        <Link
          href="/start"
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          Get AI name ideas — free
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

// Neutral cell for cloaked platforms (Instagram/Threads/Facebook/LinkedIn) that
// hide availability from outside checks. Honest "tap to find out", visually
// distinct from verified green/red and from amber "couldn't tell".
const CHECK_TONE = {
  label: "Check it",
  Icon: ExternalLink,
  border: "border-sky-500/40",
  bg: "bg-sky-500/5",
  text: "text-sky-600 dark:text-sky-400",
} as const;

function tone(status: AvailabilityStatus) {
  switch (status) {
    case "available":
      return {
        label: "Available",
        Icon: Check,
        border: "border-emerald-500/40",
        bg: "bg-emerald-500/5",
        text: "text-emerald-600 dark:text-emerald-400",
      };
    case "taken":
      return {
        label: "Taken",
        Icon: X,
        border: "border-destructive/40",
        bg: "bg-destructive/5",
        text: "text-destructive",
      };
    case "invalid":
      return {
        label: "Not allowed here",
        Icon: Ban,
        border: "border-border",
        bg: "bg-muted/30",
        text: "text-muted-foreground",
      };
    default:
      return {
        label: "Unknown",
        Icon: HelpCircle,
        border: "border-amber-500/40",
        bg: "bg-amber-500/5",
        text: "text-amber-600 dark:text-amber-400",
      };
  }
}

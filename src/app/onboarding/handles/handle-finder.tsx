"use client";

import { useActionState } from "react";
import { Sparkles, Check, X, HelpCircle, Ban, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PLATFORMS } from "@/lib/handles/platforms";
import type { AvailabilityStatus } from "@/lib/handles/availability";
import {
  findHandlesAction,
  checkHandleAction,
  type FindHandlesState,
  type HandleRow,
} from "./actions";

const initial: FindHandlesState = { error: null, rows: [], seed: null };

export function HandleFinder() {
  const [genState, genAction, genPending] = useActionState(findHandlesAction, initial);
  const [chkState, chkAction, chkPending] = useActionState(checkHandleAction, initial);

  // Show whichever ran most recently (the one with rows or an error).
  const active = chkState.rows.length || chkState.error ? chkState : genState;

  return (
    <div className="space-y-8">
      {/* Generate (the magic button) */}
      <form action={genAction} className="space-y-3 rounded-2xl border bg-card p-5">
        <label htmlFor="seed" className="text-sm font-medium">
          Find me handles
        </label>
        <p className="text-xs text-muted-foreground">
          We&apos;ll suggest brandable usernames from your brand brief and check them across every
          platform. Add a word to anchor them (optional).
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="seed"
            name="seed"
            placeholder="e.g. your brand name (optional)"
            maxLength={60}
            className="flex-1"
          />
          <Button type="submit" disabled={genPending}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
            {genPending ? "Finding…" : "Find handles"}
          </Button>
        </div>
      </form>

      {/* Check a specific handle */}
      <form action={chkAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <label htmlFor="handle" className="text-xs font-medium text-muted-foreground">
            …or check one you already have in mind
          </label>
          <Input id="handle" name="handle" placeholder="yourhandle" maxLength={40} />
        </div>
        <Button type="submit" variant="outline" disabled={chkPending}>
          {chkPending ? "Checking…" : "Check availability"}
        </Button>
      </form>

      {active.error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{active.error}</p>
        </div>
      ) : null}

      {active.rows.length ? (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Green = looks available, red = looks taken, grey = couldn&apos;t tell. For everything
            except Bluesky this is a best-effort signal — always confirm on the platform via{" "}
            <span className="font-medium">Claim →</span>.
          </p>
          {active.rows.map((row) => (
            <HandleCard key={row.handle} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HandleCard({ row }: { row: HandleRow }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-base font-semibold">@{row.handle}</p>
        <p className="text-xs text-muted-foreground">{row.rationale}</p>
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {row.availability.map((a) => {
          const spec = PLATFORMS[a.platform];
          const t = tone(a.status);
          // Where the user goes to claim: signup/profile for available; the live
          // profile for taken (so they can see who has it).
          const href =
            a.status === "taken" ? spec.profileUrl(row.handle) : spec.claimUrl(row.handle);
          return (
            <li
              key={a.platform}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${t.border} ${t.bg}`}
            >
              <t.Icon className={`h-4 w-4 shrink-0 ${t.text}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{spec.label}</span>
                <span className={`block text-[10px] ${t.text}`}>{t.label}</span>
              </span>
              {a.status !== "invalid" ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 rounded text-[10px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title={a.status === "taken" ? "View who has it" : `Claim @${row.handle} on ${spec.label}`}
                >
                  {a.status === "taken" ? "View" : "Claim"}
                  <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { DmCapabilityHint } from "@/lib/interactions/auto-reply/policy";
import type { EngagementMode } from "@/lib/db/types";
import {
  setDmCaptureModeAction,
  setLeadKeywordRuleAction,
} from "./actions";

// Bet 4 (046) — comment→DM lead-capture settings surface. Two cooperating
// controls on the channel settings page, alongside the auto-reply toggle:
//
//   1. DmCaptureToggle — per-account opt-in for the comment→DM path. Like
//      auto-reply, it's the riskier autonomous behaviour (it messages a
//      STRANGER privately), so it's only offered once trust mode is on, the
//      copy is explicit about what sends, and an HONEST per-channel capability
//      hint says when a send will no-op (X paid dm.write / LinkedIn partnership
//      / Bluesky chat). The workspace kill switch (rendered by the auto-reply
//      surface above) stops this too — one lever for all autonomous sends.
//
//   2. LeadRuleEditor — the keyword→DM rule (keywords, link, optional message,
//      optional value). Validated server-side at the boundary; an empty form
//      CLEARS the rule. Configuring a rule never sends anything; it only fires
//      when both dm_capture_enabled and trust_mode are on AND a keyword matches.

// ── DM capture mode toggle (tri-state) ──────────────────────────────────────

// Mirrors AutoReplyToggle's off/shadow/live model (migration 048). Shadow drafts
// the DM it WOULD send and logs it, but never messages, never tags a lead, never
// flips the interaction — the safe way to preview before going live.
const DM_MODE_COPY: Record<EngagementMode, string> = {
  off: "Does nothing on this channel.",
  shadow:
    "Drafts the DM it WOULD send to a matching commenter and logs it for review — but never messages anyone, never tags a lead. Zero blast radius. Start here.",
  live: "Drafts AND sends a private DM automatically when a keyword matches — no review step.",
};

export function DmCaptureToggle({
  accountId,
  channel,
  trustMode,
  mode,
  supported,
  killSwitchEngaged,
  capability,
}: {
  accountId: string;
  channel: string;
  trustMode: boolean;
  mode: EngagementMode;
  supported: boolean;
  killSwitchEngaged: boolean;
  capability: DmCapabilityHint;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setDmMode(next: EngagementMode) {
    if (next === mode) return;
    start(async () => {
      const r = await setDmCaptureModeAction(accountId, next);
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  if (!supported) {
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <p className="text-sm font-medium">Comment → DM lead capture</p>
        <p className="text-xs text-muted-foreground">
          Not available on {channel}. Comment→DM ships on X, Bluesky, and
          LinkedIn only.
        </p>
      </div>
    );
  }

  const modes: EngagementMode[] = ["off", "shadow", "live"];

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">Comment → DM lead capture: {mode}</p>
      <p className="text-xs text-muted-foreground">
        When live, an incoming comment/mention that matches a keyword below gets
        the author a <em>private direct message</em> with your link — sent
        automatically, no review step. Off by default; <em>shadow</em> previews
        it safely. Messaging a stranger is higher-risk than a public reply, so
        the DM rate cap is stricter and the workspace kill switch stops this too.
        Engaging requires trust mode.
      </p>

      {/* Honest, per-channel capability hint. */}
      <div
        className={
          capability.available
            ? "rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2"
            : "rounded-md border border-muted bg-muted/40 p-2"
        }
      >
        <p className="text-xs font-medium">
          DM capability: {capability.available ? "available" : "needs " + capability.requirement}
        </p>
        <p className="text-xs text-muted-foreground">{capability.note}</p>
      </div>

      {killSwitchEngaged ? (
        <p className="text-xs font-medium text-destructive">
          Kill switch engaged — comment→DM is paused for the whole workspace.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {modes.map((m) => {
          // shadow sends no DM → reachable without trust (preview). live messages
          // a real stranger → still gated on the publishing trust bar.
          const gated = m === "live" && !trustMode;
          const active = m === mode;
          return (
            <Button
              key={m}
              variant={active ? "default" : "outline"}
              disabled={pending || gated || active}
              onClick={() => setDmMode(m)}
            >
              {active ? `✓ ${m}` : m}
            </Button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{DM_MODE_COPY[mode]}</p>
      {!trustMode ? (
        <span className="text-xs text-muted-foreground">
          Shadow works now (it previews without sending). Going <em>live</em>{" "}
          requires trust mode.
        </span>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

// ── Lead keyword rule editor ─────────────────────────────────────────────────

export function LeadRuleEditor({
  accountId,
  channel,
  supported,
  initial,
}: {
  accountId: string;
  channel: string;
  supported: boolean;
  // Pre-filled flat form values derived from the stored rule (leadRuleToForm).
  initial: { keywords: string; link: string; message: string; valueDollars: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [keywords, setKeywords] = useState(initial.keywords);
  const [link, setLink] = useState(initial.link);
  const [message, setMessage] = useState(initial.message);
  const [valueDollars, setValueDollars] = useState(initial.valueDollars);

  const isClear =
    keywords.trim() === "" &&
    link.trim() === "" &&
    message.trim() === "" &&
    valueDollars.trim() === "";

  function save() {
    start(async () => {
      const r = await setLeadKeywordRuleAction(accountId, {
        keywords,
        link,
        message,
        valueDollars,
      });
      if (r.error) {
        setTopError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        setSaved(false);
      } else {
        setTopError(null);
        setFieldErrors({});
        setSaved(true);
        router.refresh();
      }
    });
  }

  if (!supported) {
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <p className="text-sm font-medium">Keyword → DM rule</p>
        <p className="text-xs text-muted-foreground">
          Not available on {channel}. Keyword rules ship on X, Bluesky, and
          LinkedIn only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">Keyword → DM rule</p>
        <p className="text-xs text-muted-foreground">
          When comment→DM is on, a comment containing any of these keywords
          triggers a DM with your link. Clear all fields and save to remove the
          rule (comment→DM then never fires for this account).
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="lkr-keywords">Keywords (comma-separated)</Label>
        <Input
          id="lkr-keywords"
          placeholder="pricing, demo, how much"
          value={keywords}
          disabled={pending}
          onChange={(e) => setKeywords(e.target.value)}
        />
        {fieldErrors.keywords ? (
          <p className="text-xs text-destructive">{fieldErrors.keywords}</p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="lkr-link">Link to DM back</Label>
        <Input
          id="lkr-link"
          type="url"
          placeholder="https://book.example.com/demo"
          value={link}
          disabled={pending}
          onChange={(e) => setLink(e.target.value)}
        />
        {fieldErrors.link ? (
          <p className="text-xs text-destructive">{fieldErrors.link}</p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="lkr-message">DM message (optional)</Label>
        <Textarea
          id="lkr-message"
          placeholder="Thanks for asking! Here's the link: {{link}}"
          value={message}
          disabled={pending}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Use <code>{"{{link}}"}</code> where the link should go. Left blank, we
          use a neutral default and append the link.
        </p>
        {fieldErrors.message ? (
          <p className="text-xs text-destructive">{fieldErrors.message}</p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="lkr-value">Lead value (optional, USD)</Label>
        <Input
          id="lkr-value"
          inputMode="decimal"
          placeholder="25"
          value={valueDollars}
          disabled={pending}
          onChange={(e) => setValueDollars(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Attributed to each captured lead in outcome reporting. Optional.
        </p>
        {fieldErrors.valueDollars ? (
          <p className="text-xs text-destructive">{fieldErrors.valueDollars}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending} onClick={save}>
          {isClear ? "Clear rule" : "Save rule"}
        </Button>
        {saved ? (
          <span className="text-xs text-emerald-600">Saved.</span>
        ) : null}
      </div>

      {topError ? <p className="text-sm text-destructive">{topError}</p> : null}
    </div>
  );
}

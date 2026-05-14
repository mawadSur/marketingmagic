"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { startPreviewAction, type StartActionState } from "@/app/start/actions";

const initialState: StartActionState = { error: null, needsPaste: false };

// Channel pickers. Bluesky leads because it's the only channel we actually
// scrape unauthenticated — visitors who pick Bluesky get the instant magic
// moment; visitors who pick the others get a polite paste-fallback prompt.
const CHANNEL_OPTIONS: Array<{ id: string; label: string; subtitle: string }> = [
  { id: "bluesky", label: "Bluesky", subtitle: "Public scrape — instant preview" },
  { id: "x", label: "X", subtitle: "Paste your posts" },
  { id: "linkedin", label: "LinkedIn", subtitle: "Paste your posts" },
  { id: "instagram", label: "Instagram", subtitle: "Paste your captions" },
  { id: "threads", label: "Threads", subtitle: "Paste your posts" },
];

export function LandingForm() {
  const [state, formAction, pending] = useActionState(startPreviewAction, initialState);
  const [channel, setChannel] = useState<string>("bluesky");
  const [showPaste, setShowPaste] = useState(false);

  // When the server signals we need a paste fallback, keep that panel open.
  const pasteOpen = showPaste || state.needsPaste;

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label>Which channel?</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {CHANNEL_OPTIONS.map((opt) => {
            const selected = channel === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setChannel(opt.id)}
                className={
                  "flex flex-col items-start rounded-md border px-3 py-2 text-left text-xs transition-colors " +
                  (selected
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-input bg-background text-muted-foreground hover:border-muted-foreground/40")
                }
                aria-pressed={selected}
              >
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
                <span className="mt-0.5 text-[11px]">{opt.subtitle}</span>
              </button>
            );
          })}
        </div>
        {/* Hidden field serializes the radio state. */}
        <input type="hidden" name="channel" value={channel} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="handle">Your handle</Label>
        <Input
          id="handle"
          name="handle"
          placeholder={channel === "bluesky" ? "alice.bsky.social or alice" : "yourname"}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        <p className="text-xs text-muted-foreground">
          No login. We never store this — your preview lives in a 24-hour link.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="niche_hint">What do you make? (optional)</Label>
        <Input
          id="niche_hint"
          name="niche_hint"
          placeholder="indie SaaS for designers / climbing coach / etc."
          maxLength={280}
        />
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setShowPaste((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {pasteOpen ? "Use auto-fetch instead" : "Or paste 5–20 of your posts (recommended for X / LinkedIn / IG)"}
        </button>
        {pasteOpen ? (
          <Textarea
            id="pasted_posts"
            name="pasted_posts"
            rows={8}
            placeholder={
              "Paste one post per line, or separate posts with blank lines.\n\nWe use these to learn your voice, then write the preview plan in that voice."
            }
            maxLength={20_000}
          />
        ) : null}
      </div>

      {state.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Reading your voice…" : "Show me my preview plan"}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">
        Free preview. No credit card. Limit 5 / hour per IP.
      </p>
    </form>
  );
}

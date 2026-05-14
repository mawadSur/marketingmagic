"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ingestSourceAction, type IngestSourceState } from "./actions";

const initial: IngestSourceState = { error: null, sourceId: null };

type Mode = "url" | "paste";

export function NewSourceForm() {
  const [state, formAction, pending] = useActionState(ingestSourceAction, initial);
  const [mode, setMode] = useState<Mode>("url");

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="mode" value={mode} />

      <div className="space-y-2">
        <Label>Source type</Label>
        <div className="flex rounded-md border bg-card p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("url")}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${
              mode === "url"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => setMode("paste")}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${
              mode === "paste"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Paste text
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "url"
            ? "Public http(s) URL. Articles, blog posts, and marketing pages work great. PDFs and YouTube audio need pasted text for now."
            : "Drop in a transcript, meeting notes, or any text you'd like to anchor a cluster to."}
        </p>
      </div>

      {mode === "url" ? (
        <div className="space-y-2">
          <Label htmlFor="url">URL</Label>
          <Input
            id="url"
            name="url"
            type="url"
            placeholder="https://example.com/your-blog-post"
            required
            className="text-sm"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="text">Source text</Label>
          <Textarea
            id="text"
            name="text"
            rows={10}
            placeholder="Paste the transcript, article, or notes here…"
            required
            minLength={50}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">At least 50 characters; ~200 words gives the best results.</p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="title">
          Title{mode === "paste" ? "" : " (optional — we'll auto-detect if blank)"}
        </Label>
        <Input
          id="title"
          name="title"
          type="text"
          placeholder={mode === "url" ? "How we cut our churn in half" : "Founder office hours · 2026-05-13"}
          maxLength={280}
          required={mode === "paste"}
          className="text-sm"
        />
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="rights_ok"
          required
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
        />
        <span className="text-muted-foreground">
          I own this content, have rights to use it, or it's public material I'm legally allowed
          to summarize and reference.
        </span>
      </label>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Extracting (≈5s)…" : "Extract source"}
      </Button>
    </form>
  );
}

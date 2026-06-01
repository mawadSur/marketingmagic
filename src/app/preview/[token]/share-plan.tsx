"use client";

import { useState, useTransition } from "react";
import { track } from "@vercel/analytics";
import { createShareFromTokenAction } from "./actions";

// "Share this plan" affordance on the just-generated preview. On first click we
// persist the plan under a short slug (server action) and swap the button for a
// read-only, copy-able /p/<slug> link. The signed token never leaves this page;
// only the opaque slug travels in the shared URL. Degrades gracefully if the
// Clipboard API is blocked (older browsers / non-secure contexts).
export function SharePlan({ token, channel }: { token: string; channel: string }) {
  const [pending, start] = useTransition();
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function createShare() {
    setError(null);
    start(async () => {
      const r = await createShareFromTokenAction(token);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const url = `${window.location.origin}${r.path}`;
      setShareUrl(url);
      try {
        track("mm_preview_shared", { channel });
      } catch {
        /* never break the flow on analytics failure */
      }
      // Best-effort copy on creation so the common path is one click.
      void copy(url);
    });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (shareUrl) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="mm-share-url">
          Shareable link
        </label>
        <div className="flex gap-2">
          <input
            id="mm-share-url"
            readOnly
            value={shareUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
            aria-label="Shareable preview link"
          />
          <button
            type="button"
            onClick={() => copy(shareUrl)}
            className="inline-flex h-9 shrink-0 items-center rounded-md border border-input px-3 text-sm font-medium transition-colors hover:bg-accent"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Anyone with this link can view the plan — no login, no account data.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={createShare}
        className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
      >
        {pending ? "Creating link…" : "Share this plan"}
      </button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

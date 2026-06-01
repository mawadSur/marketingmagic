"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAttributionEnabledAction } from "./actions";

// Copy-to-clipboard for the invite link. Read-only input + a button that
// reflects copied state for ~2s. Falls back gracefully if the Clipboard API
// is unavailable (older browsers / non-secure contexts) by selecting the text.
export function CopyInviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — leave it to the user to copy manually.
      setCopied(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
        aria-label="Your invite link"
      />
      <Button type="button" variant="secondary" onClick={copy} className="shrink-0">
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

// The "Made with marketingmagic" attribution toggle. Optimistic-free: we flip
// on the server then refresh so the rendered state is always the source of
// truth. Disabled (with an explainer) for paid workspaces, where the line never
// ships regardless of the flag.
export function AttributionToggle({
  enabled,
  isHobby,
}: {
  enabled: boolean;
  isHobby: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip(next: boolean) {
    start(async () => {
      const r = await setAttributionEnabledAction(next);
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            Attribution line: {enabled ? "on" : "off"}
          </p>
          <p className="text-xs text-muted-foreground">
            {isHobby
              ? 'Adds a subtle "Made with marketingmagic" line to your published posts.'
              : "Attribution only applies on the free Hobby plan — your paid posts never include it."}
          </p>
        </div>
        {enabled ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => flip(false)}
            className="shrink-0"
          >
            Turn off
          </Button>
        ) : (
          <Button disabled={pending} onClick={() => flip(true)} className="shrink-0">
            Turn on
          </Button>
        )}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

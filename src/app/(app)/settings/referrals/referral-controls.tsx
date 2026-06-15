"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { setAttributionEnabledAction } from "./actions";

// Reusable copy-to-clipboard helper. Returns a click handler + the transient
// "copied" flag (true for ~2s) so callers can render their own affordance.
// Falls back silently if the Clipboard API is unavailable (older browsers /
// non-secure contexts) — the user can still select & copy manually.
function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return { copied, copy };
}

// Copy-to-clipboard for the invite link. Read-only input + a button that
// reflects copied state for ~2s.
export function CopyInviteLink({ url }: { url: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
        aria-label="Your invite link"
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => copy(url)}
        className="shrink-0"
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

// Build-in-public share module: pre-written, founder-flavored copy a user can
// edit, a one-click "Share on X" intent button (X-first, per the wedge), and a
// "copy post" fallback for everywhere else. The referral link rides along so
// every share is attributable. The textarea is the user's voice — they tweak it
// before posting; the link is appended by X's intent (the `url` param) so it
// never gets mangled by an over-eager edit.
export function ShareModule({ url }: { url: string }) {
  const { copied, copy } = useCopy();
  const [text, setText] = useState(DEFAULT_SHARE_COPY);

  // X's web intent appends the URL itself (as a t.co-wrapped link), so we pass
  // the body as `text` and the invite link as `url` — keeping them separate
  // means the link survives even if the user rewrites the message.
  const intentHref = useMemo(() => {
    const params = new URLSearchParams({ text, url });
    return `https://x.com/intent/tweet?${params.toString()}`;
  }, [text, url]);

  // The full post the user copies for non-X platforms — body + link inline.
  const fullPost = `${text} ${url}`;

  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="text-sm"
        aria-label="Share message"
      />
      <div className="flex flex-wrap gap-2">
        <Button asChild className="shrink-0">
          <a href={intentHref} target="_blank" rel="noopener noreferrer">
            Share on X
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => copy(fullPost)}
          className="shrink-0"
        >
          {copied ? "Copied" : "Copy post"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Posting on X opens a pre-filled tweet with your invite link attached.
        Tweak the wording first — it&apos;s your voice.
      </p>
    </div>
  );
}

// Default build-in-public share copy. No invite link inline — X's intent
// appends it via the `url` param, and ShareModule appends it for the copy path.
const DEFAULT_SHARE_COPY =
  "I've been using marketingmagic to run my socials while I build — it drafts posts in my voice and even makes the videos. Here's a free week:";

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

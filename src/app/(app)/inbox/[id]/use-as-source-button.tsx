"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useAsSourceAction } from "./actions";

// "Use as source →" button. Wraps useAsSourceAction so the user gets
// inline error feedback (the body might be too short, etc.) without a
// full page reload.

interface UseAsSourceButtonProps {
  interactionId: string;
}

export function UseAsSourceButton({ interactionId }: UseAsSourceButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const res = await useAsSourceAction(interactionId);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.sourceId) {
        router.push(`/sources/${res.sourceId}`);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        {pending ? "Saving…" : "Use as source →"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

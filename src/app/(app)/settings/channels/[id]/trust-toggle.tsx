"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setTrustModeAction } from "./actions";

export function TrustToggle({
  accountId,
  trustMode,
  eligible,
}: {
  accountId: string;
  trustMode: boolean;
  eligible: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip(enable: boolean) {
    start(async () => {
      const r = await setTrustModeAction(accountId, enable);
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">
        Trust mode: {trustMode ? "on" : "off"}
      </p>
      <p className="text-xs text-muted-foreground">
        When on, new drafts skip the queue and schedule themselves for 24h from now. You can revoke
        each one from the queue, or flip trust mode back off here.
      </p>
      <div className="flex gap-2">
        {trustMode ? (
          <Button variant="destructive" disabled={pending} onClick={() => flip(false)}>
            Turn off
          </Button>
        ) : (
          <Button disabled={!eligible || pending} onClick={() => flip(true)}>
            Turn on
          </Button>
        )}
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

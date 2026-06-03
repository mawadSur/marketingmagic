"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { disconnectAccountAction } from "./actions";

// Disconnect affordance for a connected channel. Two-step (click → confirm) so
// a stray click can't cut off a channel the user relies on. On success we send
// them back to the channels list, where the slot is now free to reconnect.
export function DisconnectButton({
  accountId,
  channel,
  handle,
}: {
  accountId: string;
  channel: string;
  handle: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    start(async () => {
      const r = await disconnectAccountAction(accountId);
      if (r.error) {
        setError(r.error);
        setConfirming(false);
        return;
      }
      setError(null);
      router.push("/settings/channels");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-destructive/30 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Disconnect this channel</p>
        <p className="text-xs text-muted-foreground">
          Stops all posting to {channel} @{handle} and removes the stored
          credentials. Your post history is kept. You can reconnect any time —
          you&apos;ll just re-authorize.
        </p>
      </div>
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Stops all posting to this channel.
      </p>
      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <Button variant="destructive" disabled={pending} onClick={disconnect}>
              {pending ? "Disconnecting…" : "Yes, disconnect"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

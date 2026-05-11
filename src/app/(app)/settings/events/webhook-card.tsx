"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { rotateWebhookSecretAction } from "./actions";

export function WebhookCard({ url, secret }: { url: string; secret: string }) {
  const [revealed, setRevealed] = useState(false);
  const [current, setCurrent] = useState(secret);

  async function rotate() {
    const next = await rotateWebhookSecretAction();
    if (next.secret) setCurrent(next.secret);
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Webhook URL</h2>
        <code className="block break-all rounded-md border bg-muted/50 px-2 py-1 text-xs">{url}</code>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Signing secret</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setRevealed((v) => !v)}>
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <Button size="sm" variant="destructive" onClick={rotate}>
              Rotate
            </Button>
          </div>
        </div>
        <code className="block break-all rounded-md border bg-muted/50 px-2 py-1 text-xs">
          {revealed ? current : "•".repeat(Math.min(current.length, 48))}
        </code>
        <p className="text-xs text-muted-foreground">
          Send <code className="rounded bg-muted px-1">X-MM-Signature: sha256=&lt;HMAC-SHA256 of raw
          body using this secret&gt;</code> with each POST.
        </p>
      </div>
    </section>
  );
}

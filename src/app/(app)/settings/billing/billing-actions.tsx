"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { PlanId } from "@/lib/billing/tiers";

type Props =
  | { workspaceId: string; mode: "checkout"; planId: PlanId; label: string }
  | { workspaceId: string; mode: "portal"; label?: string };

// Single client island for both "Upgrade" and "Manage subscription" buttons.
// They POST JSON to the route handler and follow the returned URL — keeping
// this tiny avoids a per-plan dance of separate forms.
export function BillingActions(props: Props) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const endpoint = props.mode === "checkout" ? "/api/billing/checkout" : "/api/billing/portal";
      const body =
        props.mode === "checkout"
          ? { workspaceId: props.workspaceId, planId: props.planId }
          : { workspaceId: props.workspaceId };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setError(json.error ?? `Request failed (${res.status}).`);
        setLoading(false);
        return;
      }
      // Hand off to Stripe. We don't reset loading — page is leaving anyway.
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
      setLoading(false);
    }
  }

  const label =
    props.mode === "checkout"
      ? props.label
      : props.label ?? "Manage subscription";

  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={onClick}
        disabled={loading}
        variant={props.mode === "checkout" ? "default" : "outline"}
        size="sm"
      >
        {loading ? "Loading…" : label}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

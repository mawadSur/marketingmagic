"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type Props =
  | { organizationId: string; mode: "checkout"; label: string }
  | { organizationId: string; mode: "portal"; label?: string };

// Client island for the org billing buttons. Mirrors the solo BillingActions
// island: POST JSON to the org route handler, then follow the returned Stripe
// URL. "checkout" starts the per-seat org subscription; "portal" opens the
// Stripe customer portal to manage / cancel it.
export function OrgBillingActions(props: Props) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const endpoint =
        props.mode === "checkout" ? "/api/billing/org-checkout" : "/api/billing/org-portal";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: props.organizationId }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setError(json.error ?? `Request failed (${res.status}).`);
        setLoading(false);
        return;
      }
      // Hand off to Stripe. We don't reset loading — the page is leaving anyway.
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
      setLoading(false);
    }
  }

  const label =
    props.mode === "checkout" ? props.label : props.label ?? "Manage subscription";

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

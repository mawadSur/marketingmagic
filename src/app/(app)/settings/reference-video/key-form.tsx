"use client";

// Reference-image video (bet ④) — BYO key forms for the providers:
//   fal video (Capability A — "Animate a photo")
//   D-ID      (Capability B — "Make it talk")
//   HeyGen    (Capability B — "Make it talk", second provider)
//
// Mirrors the LLM/Pexels key forms in settings/video-keys: a password field with
// show/hide, stored encrypted, never echoed back (Replace or Remove only). The
// providers are independent rows in workspace_byo_keys, so a workspace can
// configure any, all, or none.

import { useActionState, useState } from "react";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  saveFalVideoKeyAction,
  removeFalVideoKeyAction,
  saveDidVideoKeyAction,
  removeDidVideoKeyAction,
  saveHeygenVideoKeyAction,
  removeHeygenVideoKeyAction,
  type ReferenceVideoState,
} from "./actions";

const initial: ReferenceVideoState = { error: null, success: null };

// Shared Configured/Not pill + a Remove button wired to the provider's remove
// action. Kept generic so the fal and D-ID status pills are one component.
function KeyStatusPill({
  configured,
  removeAction,
}: {
  configured: boolean;
  removeAction: () => void | Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2">
      {configured ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          Configured ✓
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/30 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          Not configured
        </span>
      )}
      {configured ? (
        <form action={removeAction}>
          <Button type="submit" variant="ghost" size="sm" className="text-destructive">
            Remove
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// Shared password key field with show/hide + a "get a key" link. Generic so the
// fal and D-ID forms differ only in copy/href.
function KeyField({
  label,
  placeholder,
  helpHref,
  helpLabel,
  helpTail,
}: {
  label: string;
  placeholder: string;
  helpHref: string;
  helpLabel: string;
  helpTail: string;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="api_key">{label}</Label>
      <div className="relative">
        <Input
          id="api_key"
          name="api_key"
          type={showKey ? "text" : "password"}
          placeholder={placeholder}
          autoComplete="off"
          className="pr-10"
          required
        />
        <button
          type="button"
          onClick={() => setShowKey((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={showKey ? "Hide key" : "Show key"}
        >
          {showKey ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        <a
          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          href={helpHref}
          target="_blank"
          rel="noreferrer"
        >
          {helpLabel}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>{" "}
        · {helpTail}
      </p>
    </div>
  );
}

// ── fal video key (Capability A — "Animate a photo") ────────────────────────

export function FalVideoKeyStatus({ configured }: { configured: boolean }) {
  return <KeyStatusPill configured={configured} removeAction={removeFalVideoKeyAction} />;
}

export function FalVideoKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveFalVideoKeyAction, initial);

  return (
    <form action={action} className="space-y-4">
      <KeyField
        label="fal API key"
        placeholder={configured ? "Enter a new key to replace the stored one" : "fal-key-id:secret"}
        helpHref="https://fal.ai/dashboard/keys"
        helpLabel="Get a fal key"
        helpTail="You pay fal directly. Stored encrypted — never displayed again."
      />

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace fal key" : "Save fal key"}
      </Button>
    </form>
  );
}

// ── D-ID key (Capability B — "Make it talk") ────────────────────────────────

export function DidVideoKeyStatus({ configured }: { configured: boolean }) {
  return <KeyStatusPill configured={configured} removeAction={removeDidVideoKeyAction} />;
}

export function DidVideoKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveDidVideoKeyAction, initial);

  return (
    <form action={action} className="space-y-4">
      <KeyField
        label="D-ID API key"
        placeholder={configured ? "Enter a new key to replace the stored one" : "Your D-ID API key"}
        helpHref="https://studio.d-id.com/account-settings/api-keys"
        helpLabel="Get a D-ID key"
        helpTail="You pay D-ID directly. Stored encrypted — never displayed again."
      />

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace D-ID key" : "Save D-ID key"}
      </Button>
    </form>
  );
}

// ── HeyGen key (Capability B — "Make it talk", second provider) ──────────────

export function HeygenVideoKeyStatus({ configured }: { configured: boolean }) {
  return <KeyStatusPill configured={configured} removeAction={removeHeygenVideoKeyAction} />;
}

export function HeygenVideoKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveHeygenVideoKeyAction, initial);

  return (
    <form action={action} className="space-y-4">
      <KeyField
        label="HeyGen API key"
        placeholder={configured ? "Enter a new key to replace the stored one" : "Your HeyGen API key"}
        helpHref="https://app.heygen.com/settings?nav=API"
        helpLabel="Get a HeyGen key"
        helpTail="You pay HeyGen directly. Stored encrypted — never displayed again."
      />

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace HeyGen key" : "Save HeyGen key"}
      </Button>
    </form>
  );
}

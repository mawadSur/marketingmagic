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
import { Eye, EyeOff, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react";
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
  saveHiggsfieldVideoKeyAction,
  removeHiggsfieldVideoKeyAction,
  type ReferenceVideoState,
} from "./actions";

const initial: ReferenceVideoState = { error: null, success: null };

// Codebase-standard keyboard focus ring, shared by the "get a key" link and the
// show/hide password toggle (neither is a styled <Button>/<Input>, so they need
// it applied explicitly).
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// Shared success/error message rows. Color alone isn't an accessible signal, so
// each leads with a lucide icon (matching the onboarding wizard pattern).
function FormError({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function FormSuccess({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

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
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          Configured
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/30 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden />
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

// Shared password key field with show/hide + an optional "get a key" link.
// Generic so the provider forms differ only in copy/href. `name` defaults to
// "api_key" (single-token providers); Higgsfield passes id/secret field names.
// The help link is only rendered on the field that supplies `helpHref` so a
// two-field form doesn't repeat it.
function KeyField({
  label,
  placeholder,
  helpHref,
  helpLabel,
  helpTail,
  name = "api_key",
}: {
  label: string;
  placeholder: string;
  helpHref?: string;
  helpLabel?: string;
  helpTail?: string;
  name?: string;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label} <span className="text-destructive">*</span>
      </Label>
      <div className="relative">
        <Input
          id={name}
          name={name}
          type={showKey ? "text" : "password"}
          placeholder={placeholder}
          autoComplete="off"
          className="pr-10"
          required
        />
        <button
          type="button"
          onClick={() => setShowKey((s) => !s)}
          className={`absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground ${FOCUS_RING}`}
          aria-label={showKey ? "Hide key" : "Show key"}
        >
          {showKey ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {helpHref ? (
        <p className="text-xs text-muted-foreground">
          <a
            className={`inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline ${FOCUS_RING}`}
            href={helpHref}
            target="_blank"
            rel="noreferrer"
            title="Opens in new window"
          >
            {helpLabel}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>{" "}
          · {helpTail}
        </p>
      ) : null}
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

      {state.error ? <FormError message={state.error} /> : null}
      {state.success ? <FormSuccess message={state.success} /> : null}

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

      {state.error ? <FormError message={state.error} /> : null}
      {state.success ? <FormSuccess message={state.success} /> : null}

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

      {state.error ? <FormError message={state.error} /> : null}
      {state.success ? <FormSuccess message={state.success} /> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace HeyGen key" : "Save HeyGen key"}
      </Button>
    </form>
  );
}

// ── Higgsfield key (UGC avatar video — a saved avatar + a script) ────────────

export function HiggsfieldVideoKeyStatus({ configured }: { configured: boolean }) {
  return <KeyStatusPill configured={configured} removeAction={removeHiggsfieldVideoKeyAction} />;
}

export function HiggsfieldVideoKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveHiggsfieldVideoKeyAction, initial);

  // Higgsfield issues a PAIR — an API Key ID and an API Key Secret. Both are
  // required and stored encrypted together; the help link rides the second
  // field so it appears once.
  return (
    <form action={action} className="space-y-4">
      <KeyField
        name="api_key_id"
        label="Higgsfield API Key ID"
        placeholder={configured ? "Enter a new ID to replace the stored one" : "Your Higgsfield API Key ID"}
      />
      <KeyField
        name="api_key_secret"
        label="Higgsfield API Key Secret"
        placeholder={configured ? "Enter a new secret to replace the stored one" : "Your Higgsfield API Key Secret"}
        helpHref="https://higgsfield.ai/settings/api-keys"
        helpLabel="Get your Higgsfield API keys"
        helpTail="Both the Key ID and Secret. You pay Higgsfield directly. Stored encrypted — never displayed again."
      />

      {state.error ? <FormError message={state.error} /> : null}
      {state.success ? <FormSuccess message={state.success} /> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace Higgsfield keys" : "Save Higgsfield keys"}
      </Button>
    </form>
  );
}

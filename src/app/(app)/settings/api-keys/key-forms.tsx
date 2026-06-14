"use client";

import { useActionState, useState } from "react";
import { Copy, Check, CheckCircle2, AlertCircle, KeyRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createApiKeyAction,
  revokeApiKeyAction,
  type ApiKeysState,
} from "./actions";
import type { ApiKeyListItem } from "@/lib/api/manage";

const initial: ApiKeysState = { error: null, success: null, createdKey: null };

// Scope catalog shown as checkboxes. Mirrors API_SCOPES in src/lib/api/keys.ts;
// the human blurb explains what each unlocks so a user isn't guessing.
const SCOPES: Array<{ value: string; label: string; hint: string }> = [
  { value: "channels:read", label: "Read channels", hint: "List the workspace's connected channels." },
  { value: "posts:read", label: "Read posts", hint: "List and fetch scheduled / published posts." },
  { value: "posts:write", label: "Write posts", hint: "Schedule new posts and cancel scheduled ones." },
  { value: "plans:read", label: "Read plans", hint: "Read generated posting plans." },
  { value: "plans:write", label: "Generate plans", hint: "Trigger AI plan generation." },
  { value: "analytics:read", label: "Read analytics", hint: "Read engagement + theme-winner analytics." },
];

// One-time reveal of a freshly minted key. Shown only in the response of the
// create action — the raw value is never stored, so this is the single chance
// to copy it.
function RevealedKey({ name, raw }: { name: string; raw: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        Key &ldquo;{name}&rdquo; created
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Copy it now — for your security it will never be shown again.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-background px-3 py-2 text-xs font-mono">
          {raw}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(raw);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

export function CreateKeyForm() {
  const [state, action, pending] = useActionState(createApiKeyAction, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">
          Key name <span className="text-destructive">*</span>
        </Label>
        <Input id="name" name="name" placeholder="e.g. n8n production" autoComplete="off" required />
        <p className="text-xs text-muted-foreground">A label so you can tell your keys apart.</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Scopes</legend>
        <p className="text-xs text-muted-foreground">
          Grant only what this key needs. A request to an endpoint outside its scopes is rejected.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {SCOPES.map((s) => (
            <label
              key={s.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 hover:bg-muted/50"
            >
              <input
                type="checkbox"
                name="scopes"
                value={s.value}
                className="mt-0.5 h-4 w-4 shrink-0 accent-current"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium leading-none">{s.label}</span>
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}

      {state.createdKey ? (
        <RevealedKey name={state.createdKey.name} raw={state.createdKey.raw} />
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create key"}
      </Button>
    </form>
  );
}

function RevokeButton({ id }: { id: string }) {
  return (
    <form action={revokeApiKeyAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" className="text-destructive">
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        <span className="ml-1">Revoke</span>
      </Button>
    </form>
  );
}

export function KeyList({ keys }: { keys: ApiKeyListItem[] }) {
  if (keys.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No API keys yet. Create one above to start calling the API.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {keys.map((k) => (
        <li key={k.id} className="flex items-start justify-between gap-3 p-3">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {k.name}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{k.key_prefix}…</p>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {k.scopes.map((s) => (
                <span
                  key={s}
                  className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {s}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {k.last_used_at ? `Last used ${new Date(k.last_used_at).toLocaleDateString()}` : "Never used"}
              {" · "}
              Created {new Date(k.created_at).toLocaleDateString()}
            </p>
          </div>
          <RevokeButton id={k.id} />
        </li>
      ))}
    </ul>
  );
}

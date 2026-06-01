"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  saveLlmKeyAction,
  savePexelsKeyAction,
  removeKeyAction,
  type VideoKeysState,
} from "./actions";

const initial: VideoKeysState = { error: null, success: null };

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const LLM_OPTIONS: { value: string; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Google Gemini" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "moonshot", label: "Moonshot" },
  { value: "azure", label: "Azure OpenAI" },
  { value: "qwen", label: "Qwen" },
  { value: "ollama", label: "Ollama" },
  { value: "g4f", label: "gpt4free (g4f)" },
  { value: "oneapi", label: "OneAPI" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "ernie", label: "ERNIE" },
];

// A small "remove" form — plain server action (no state), so it can sit
// inside the status row without its own useActionState.
function RemoveButton({ provider, label }: { provider: "llm" | "pexels"; label: string }) {
  return (
    <form action={removeKeyAction}>
      <input type="hidden" name="provider" value={provider} />
      <Button type="submit" variant="ghost" size="sm" className="text-destructive">
        {label}
      </Button>
    </form>
  );
}

export function LlmKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveLlmKeyAction, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="provider">Provider</Label>
        <select id="provider" name="provider" defaultValue="openai" className={SELECT_CLASS}>
          {LLM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="api_key">API key</Label>
        <Input
          id="api_key"
          name="api_key"
          type="password"
          placeholder={configured ? "Enter a new key to replace the stored one" : "sk-…"}
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          Stored encrypted. We never display it again — only Replace or Remove.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="model_name">Model name</Label>
          <Input id="model_name" name="model_name" placeholder="gpt-4o-mini" autoComplete="off" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="base_url">Base URL (optional)</Label>
          <Input id="base_url" name="base_url" placeholder="https://api.openai.com/v1" autoComplete="off" />
        </div>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace LLM key" : "Save LLM key"}
      </Button>
    </form>
  );
}

export function PexelsKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(savePexelsKeyAction, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="api_keys">Pexels API key(s)</Label>
        <Textarea
          id="api_keys"
          name="api_keys"
          rows={3}
          placeholder={"one key per line\nor comma-separated"}
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          Multiple keys are rotated to dodge rate limits. Get one free at{" "}
          <a
            className="underline-offset-4 hover:underline"
            href="https://www.pexels.com/api/"
            target="_blank"
            rel="noreferrer"
          >
            pexels.com/api
          </a>
          . Stored encrypted — never displayed again.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace Pexels key(s)" : "Save Pexels key(s)"}
      </Button>
    </form>
  );
}

// Status pill + Remove affordance. Presence only — never a value.
export function KeyStatus({
  configured,
  provider,
}: {
  configured: boolean;
  provider: "llm" | "pexels";
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
      {configured ? <RemoveButton provider={provider} label="Remove" /> : null}
    </div>
  );
}

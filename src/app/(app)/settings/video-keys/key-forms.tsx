"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  saveLlmKeyAction,
  savePexelsKeyAction,
  saveAnalysisKeyAction,
  removeKeyAction,
  type VideoKeysState,
} from "./actions";

const initial: VideoKeysState = { error: null, success: null };

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// Codebase-standard keyboard focus ring, shared by the "Get a key" links and
// the show/hide password toggle (neither is a styled <Button>/<Input>, so they
// need it applied explicitly).
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// Per-provider defaults so the user doesn't have to know each provider's base
// URL or a valid model id. Picking a provider prefills `model` + `baseUrl`
// (both still editable) and points "Get your key" at the right console.
// `baseUrl` left "" where it's account-specific (the user must paste their own).
interface ProviderMeta {
  value: string;
  label: string;
  model: string;
  baseUrl: string;
  keyUrl: string;
  keyHint?: string;
}

const PROVIDERS: ProviderMeta[] = [
  { value: "openai", label: "OpenAI", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { value: "openrouter", label: "OpenRouter", model: "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { value: "gemini", label: "Google Gemini", model: "gemini-1.5-flash", baseUrl: "", keyUrl: "https://aistudio.google.com/app/apikey", keyHint: "Gemini uses Google's SDK — leave Base URL blank." },
  { value: "deepseek", label: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys" },
  { value: "moonshot", label: "Moonshot", model: "moonshot-v1-8k", baseUrl: "https://api.moonshot.cn/v1", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { value: "qwen", label: "Qwen", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyUrl: "https://dashscope.console.aliyun.com/apiKey" },
  { value: "azure", label: "Azure OpenAI", model: "", baseUrl: "", keyUrl: "https://portal.azure.com/", keyHint: "Use your resource's endpoint as Base URL and your deployment name as Model." },
  { value: "cloudflare", label: "Cloudflare", model: "@cf/meta/llama-3.1-8b-instruct", baseUrl: "", keyUrl: "https://dash.cloudflare.com/profile/api-tokens", keyHint: "Base URL includes your account id — paste it from the Workers AI docs." },
  { value: "oneapi", label: "OneAPI", model: "", baseUrl: "", keyUrl: "", keyHint: "Self-hosted — paste your OneAPI gateway URL and a model it routes." },
  { value: "ollama", label: "Ollama", model: "llama3.1", baseUrl: "http://localhost:11434/v1", keyUrl: "https://ollama.com/", keyHint: "Self-hosted — the worker must be able to reach this URL." },
  { value: "ernie", label: "ERNIE", model: "ernie-bot", baseUrl: "", keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application", keyHint: "Baidu Qianfan — paste your access key." },
  { value: "g4f", label: "gpt4free (g4f)", model: "gpt-4o-mini", baseUrl: "", keyUrl: "", keyHint: "Free community provider — quality and uptime vary." },
];

const byValue = (v: string) => PROVIDERS.find((p) => p.value === v) ?? PROVIDERS[0];

// Video analysis (Hormozi slice 2) — providers whose model family has a wired
// backend. Only Gemini is wired today (native-video; Claude has no video input
// type). Prefills a sensible default model + points "Get a key" at the console.
interface AnalysisProviderMeta {
  value: string;
  label: string;
  model: string;
  keyUrl: string;
  keyHint?: string;
}
const ANALYSIS_PROVIDERS: AnalysisProviderMeta[] = [
  {
    value: "gemini",
    label: "Google Gemini",
    model: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "Native video — transcribes audio + reads the frames in one pass.",
  },
];

// A small "remove" form — plain server action (no state), so it can sit
// inside the status row without its own useActionState.
function RemoveButton({
  provider,
  label,
}: {
  provider: "llm" | "pexels" | "analysis";
  label: string;
}) {
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
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [model, setModel] = useState(PROVIDERS[0].model);
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0].baseUrl);
  const [showKey, setShowKey] = useState(false);

  function onProviderChange(value: string) {
    const next = byValue(value);
    setProvider(next);
    // Prefill the defaults for the newly chosen provider. The user can still
    // edit either field afterward.
    setModel(next.model);
    setBaseUrl(next.baseUrl);
  }

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="provider">Provider</Label>
        <select
          id="provider"
          name="provider"
          value={provider.value}
          onChange={(e) => onProviderChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {PROVIDERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {provider.keyUrl ? (
          <p className="text-xs text-muted-foreground">
            <a
              className={`inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline ${FOCUS_RING}`}
              href={provider.keyUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens in new window"
            >
              Get a {provider.label} key
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            {provider.keyHint ? <span className="ml-1">· {provider.keyHint}</span> : null}
          </p>
        ) : provider.keyHint ? (
          <p className="text-xs text-muted-foreground">{provider.keyHint}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="api_key">
          API key <span className="text-destructive">*</span>
        </Label>
        <div className="relative">
          <Input
            id="api_key"
            name="api_key"
            type={showKey ? "text" : "password"}
            placeholder={configured ? "Enter a new key to replace the stored one" : "sk-…"}
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
        <p className="text-xs text-muted-foreground">
          Stored encrypted. We never display it again — only Replace or Remove.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="model_name">Model name</Label>
          <Input
            id="model_name"
            name="model_name"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="base_url">Base URL{provider.baseUrl ? "" : " (optional)"}</Label>
          <Input
            id="base_url"
            name="base_url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </div>
      </div>

      {state.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          {state.success}
        </p>
      ) : null}

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
        <Label htmlFor="api_keys">
          Pexels API key(s) <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="api_keys"
          name="api_keys"
          rows={3}
          placeholder={"one key per line\nor comma-separated"}
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          Free to get — no card needed. Grab one at{" "}
          <a
            className={`inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline ${FOCUS_RING}`}
            href="https://www.pexels.com/api/"
            target="_blank"
            rel="noreferrer"
            title="Opens in new window"
          >
            pexels.com/api
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          . Paste several to rotate around rate limits. Stored encrypted — never displayed again.
        </p>
      </div>

      {state.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          {state.success}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace Pexels key(s)" : "Save Pexels key(s)"}
      </Button>
    </form>
  );
}

// Video analysis (Hormozi slice 2) — store the workspace's own analysis key +
// chosen model. Mirrors LlmKeyForm: pick a provider (prefills the model + the
// "Get a key" link), paste the key, edit the model if you like. Stored encrypted;
// never displayed again.
export function AnalysisKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveAnalysisKeyAction, initial);
  const [provider, setProvider] = useState(ANALYSIS_PROVIDERS[0]);
  const [model, setModel] = useState(ANALYSIS_PROVIDERS[0].model);
  const [showKey, setShowKey] = useState(false);

  function onProviderChange(value: string) {
    const next = ANALYSIS_PROVIDERS.find((p) => p.value === value) ?? ANALYSIS_PROVIDERS[0];
    setProvider(next);
    setModel(next.model);
  }

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="analysis_provider">Provider</Label>
        <select
          id="analysis_provider"
          name="provider"
          value={provider.value}
          onChange={(e) => onProviderChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {ANALYSIS_PROVIDERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {provider.keyUrl ? (
          <p className="text-xs text-muted-foreground">
            <a
              className={`inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline ${FOCUS_RING}`}
              href={provider.keyUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens in new window"
            >
              Get a {provider.label} key
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            {provider.keyHint ? <span className="ml-1">· {provider.keyHint}</span> : null}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="analysis_api_key">
          API key <span className="text-destructive">*</span>
        </Label>
        <div className="relative">
          <Input
            id="analysis_api_key"
            name="api_key"
            type={showKey ? "text" : "password"}
            placeholder={configured ? "Enter a new key to replace the stored one" : "AIza…"}
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
        <p className="text-xs text-muted-foreground">
          Stored encrypted. We never display it again — only Replace or Remove.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="analysis_model">Model</Label>
        <Input
          id="analysis_model"
          name="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gemini-2.5-flash"
          autoComplete="off"
          required
        />
      </div>

      {state.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          {state.success}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace analysis key" : "Save analysis key"}
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
  provider: "llm" | "pexels" | "analysis";
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
      {configured ? <RemoveButton provider={provider} label="Remove" /> : null}
    </div>
  );
}

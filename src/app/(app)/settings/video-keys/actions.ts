"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { byoKeysConfigured } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import {
  setWorkspaceKeys,
  removeWorkspaceKeys,
  type ByoLlmSecrets,
  type ByoPexelsSecrets,
  type ByoAnalysisSecrets,
} from "@/lib/video/byo-keys";

export type VideoKeysState = { error: string | null; success: string | null };

// Known LLM providers MPT understands. Kept as a whitelist so we never store
// a free-typed provider string that MPT would reject at render time. Mirrors
// MoneyPrinterTurbo's supported llm_provider values.
const LLM_PROVIDERS = [
  "openai",
  "openrouter",
  "gemini",
  "deepseek",
  "moonshot",
  "azure",
  "qwen",
  "ollama",
  "g4f",
  "oneapi",
  "cloudflare",
  "ernie",
] as const;

const llmSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  // The API key is the secret; trimmed and length-checked but never echoed
  // back. A generous max guards against pasted junk without rejecting long
  // provider tokens.
  api_key: z.string().trim().min(8, "API key looks too short.").max(400),
  model_name: z.string().trim().min(1, "Model name is required.").max(120),
  base_url: z
    .string()
    .trim()
    .url("Base URL must be a valid URL.")
    .max(400)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const pexelsSchema = z.object({
  // One textarea, one key per line (or comma-separated). MPT rotates across
  // multiple keys to dodge per-key rate limits, so we accept several.
  api_keys: z.string().trim().min(8, "Enter at least one Pexels API key."),
});

// Shared guard: every mutation here requires an authenticated workspace member
// AND a configured encryption key (without it setWorkspaceKeys would throw).
async function guard(): Promise<{ workspaceId: string; userId: string } | { error: string }> {
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();
  if (!byoKeysConfigured()) {
    return { error: "Video keys are not available on this deployment (BYO_ENCRYPTION_KEY is unset)." };
  }
  return { workspaceId: ws.id, userId: user.id };
}

export async function saveLlmKeyAction(
  _prev: VideoKeysState,
  formData: FormData,
): Promise<VideoKeysState> {
  const auth = await guard();
  if ("error" in auth) return { error: auth.error, success: null };

  const parsed = llmSchema.safeParse({
    provider: formData.get("provider"),
    api_key: formData.get("api_key"),
    model_name: formData.get("model_name"),
    base_url: formData.get("base_url") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  const secrets: ByoLlmSecrets = {
    provider: parsed.data.provider,
    api_key: parsed.data.api_key,
    model_name: parsed.data.model_name,
    ...(parsed.data.base_url ? { base_url: parsed.data.base_url } : {}),
  };

  try {
    await setWorkspaceKeys(auth.workspaceId, "llm", secrets, auth.userId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to save LLM key.", success: null };
  }

  revalidatePath("/settings/video-keys");
  return { error: null, success: "LLM credentials saved." };
}

export async function savePexelsKeyAction(
  _prev: VideoKeysState,
  formData: FormData,
): Promise<VideoKeysState> {
  const auth = await guard();
  if ("error" in auth) return { error: auth.error, success: null };

  const parsed = pexelsSchema.safeParse({ api_keys: formData.get("api_keys") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  // Split on newlines or commas; drop blanks and dedupe.
  const keys = Array.from(
    new Set(
      parsed.data.api_keys
        .split(/[\n,]/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 8),
    ),
  );
  if (keys.length === 0) {
    return { error: "Enter at least one valid Pexels API key.", success: null };
  }

  const secrets: ByoPexelsSecrets = { api_keys: keys };
  try {
    await setWorkspaceKeys(auth.workspaceId, "pexels", secrets, auth.userId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to save Pexels keys.", success: null };
  }

  revalidatePath("/settings/video-keys");
  return {
    error: null,
    success: `Saved ${keys.length} Pexels key${keys.length === 1 ? "" : "s"}.`,
  };
}

// Video analysis (Hormozi slice 2) — BYO analysis-provider key + chosen model.
// `provider` is the model family (only "gemini" is wired today; the input is a
// closed enum so we never store a family with no backend). `model` is the exact
// id the analyzer sends.
const ANALYSIS_PROVIDERS = ["gemini"] as const;

const analysisSchema = z.object({
  provider: z.enum(ANALYSIS_PROVIDERS),
  api_key: z.string().trim().min(8, "API key looks too short.").max(400),
  model: z.string().trim().min(1, "Model name is required.").max(120),
});

export async function saveAnalysisKeyAction(
  _prev: VideoKeysState,
  formData: FormData,
): Promise<VideoKeysState> {
  const auth = await guard();
  if ("error" in auth) return { error: auth.error, success: null };

  const parsed = analysisSchema.safeParse({
    provider: formData.get("provider"),
    api_key: formData.get("api_key"),
    model: formData.get("model"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  const secrets: ByoAnalysisSecrets = {
    provider: parsed.data.provider,
    api_key: parsed.data.api_key,
    model: parsed.data.model,
  };
  try {
    await setWorkspaceKeys(auth.workspaceId, "analysis", secrets, auth.userId);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to save analysis key.",
      success: null,
    };
  }

  revalidatePath("/settings/video-keys");
  return { error: null, success: "Analysis credentials saved." };
}

const removeSchema = z.object({ provider: z.enum(["llm", "pexels", "analysis"]) });

export async function removeKeyAction(formData: FormData): Promise<void> {
  const auth = await guard();
  if ("error" in auth) return;
  const parsed = removeSchema.safeParse({ provider: formData.get("provider") });
  if (!parsed.success) return;
  await removeWorkspaceKeys(auth.workspaceId, parsed.data.provider);
  revalidatePath("/settings/video-keys");
}

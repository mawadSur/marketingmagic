// Hosted Whisper transcription via Groq.
//
// V1 scope: this module is reachable but not wired to any user-facing
// path. The flow is one call: send audio bytes + model name → get back
// a transcript string. Groq exposes the OpenAI-compatible audio API at
// https://api.groq.com/openai/v1/audio/transcriptions, so we hit it with
// plain fetch + multipart form data and avoid pulling another SDK.
//
// Graceful degrade: when GROQ_API_KEY is unset, `transcribeAudio()`
// throws TranscriptionUnavailableError. The /sources/new flow translates
// that to a friendly "Paste the transcript instead" message — the audio/
// video kinds remain selectable but the action returns early.
//
// When wired up (Phase 2.6 Founder Mode + Phase 3 video captions both
// share this infra), the caller passes:
//   - audio bytes (mp3/m4a/wav/webm — Groq accepts all)
//   - filename hint (for content-type sniffing on Groq's side)
//   - optional model override (default: whisper-large-v3-turbo for speed)
//
// We don't expose this from /sources/new in V1 because we don't have a
// file-upload UI path here yet — paste-transcript is the V1 entry point.
// See tasks.md Phase 2.6 (Founder Mode) for the audio path that will use
// this helper.

import { serverEnv } from "@/lib/env";

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

export class TranscriptionUnavailableError extends Error {
  constructor() {
    super(
      "Audio transcription isn't configured. Paste the transcript text instead, or ask the operator to set GROQ_API_KEY.",
    );
    this.name = "TranscriptionUnavailableError";
  }
}

export class TranscriptionError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface TranscribeOptions {
  filename: string;
  // MIME hint. Groq's API sniffs from filename too, but passing both keeps
  // the upload safe across edge cases (e.g. .webm with audio/webm content).
  contentType?: string;
  model?: string;
}

export async function transcribeAudio(
  audio: ArrayBuffer | Blob,
  opts: TranscribeOptions,
): Promise<string> {
  const apiKey = serverEnv().GROQ_API_KEY;
  if (!apiKey) throw new TranscriptionUnavailableError();

  const blob =
    audio instanceof Blob
      ? audio
      : new Blob([audio], { type: opts.contentType ?? "audio/mpeg" });

  const form = new FormData();
  form.append("file", blob, opts.filename);
  form.append("model", opts.model ?? DEFAULT_MODEL);
  form.append("response_format", "json");

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(
      `Groq transcription failed (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json()) as { text?: string };
  if (typeof json.text !== "string" || json.text.length === 0) {
    throw new TranscriptionError("Groq returned an empty transcript.");
  }
  return json.text;
}

export function transcriptionConfigured(): boolean {
  try {
    return Boolean(serverEnv().GROQ_API_KEY);
  } catch {
    return false;
  }
}

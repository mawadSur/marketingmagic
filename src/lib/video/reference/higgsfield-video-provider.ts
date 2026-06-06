// UGC avatar video — Higgsfield adapter.
//
// Implements ReferenceVideoProvider against Higgsfield's async generation API.
// This powers the NEW "UGC-style content" path: the user supplies an avatar
// (an uploaded/selected reference image) plus a prompt/script, and Higgsfield
// returns a short creator-style video. It is a "present"-class capability —
// the avatar is the on-screen presenter — and slots into the SAME
// submit → poll → fetchBytes orchestration as fal/D-ID/HeyGen.
//
// Endpoints + model are NOT hardcoded: they come from env (higgsfieldBaseUrl /
// higgsfieldModel) so the exact REST surface can be corrected per deployment
// without a code change — the same graceful-config idiom as the other adapters.
//
// Assumed REST shape (override via env if Higgsfield differs):
//   submit:  POST {base}/v1/generations
//              { model, input_image_url, prompt, aspect_ratio, duration } → { id }
//   poll:    GET  {base}/v1/generations/{id}
//              → { status: queued|processing|completed|failed, output|video, error }
//   result video URL: output.video_url | video.url | output.url
//
// Auth: Higgsfield uses an API Key ID + Secret PAIR, sent as the `hf-api-key`
// and `hf-secret` headers. The workspace's BYO secret (provider
// "higgsfield_video") stores both; the orchestrator/cron pack them as
// "<id>:<secret>" into the single apiKey arg, which authHeaders() splits.
//
// Nothing here runs unless referenceVideoEnabled() is on (the factory in
// stub-provider.ts guards the flag before returning this adapter). Tests never
// make a live call — fetch is mocked.

import { higgsfieldBaseUrl, higgsfieldModel } from "@/lib/env";
import {
  type ReferenceVideoInputs,
  type ReferenceVideoPoll,
  type ReferenceVideoProvider,
  type ReferenceVideoSubmitResult,
} from "./provider";

// Higgsfield status strings → our coarse status machine. Tolerant of casing and
// a couple of synonyms different Higgsfield surfaces have used.
type HiggsfieldStatus =
  | "queued"
  | "in_queue"
  | "processing"
  | "in_progress"
  | "running"
  | "completed"
  | "succeeded"
  | "failed"
  | "error"
  | "canceled"
  | string;

interface HiggsfieldStatusResponse {
  status?: HiggsfieldStatus;
  // Output video URL appears under one of these depending on the model surface.
  output?: { video_url?: string; url?: string; video?: { url?: string } } | null;
  video?: { url?: string } | null;
  result?: { video_url?: string; url?: string } | null;
  error?: string | { message?: string } | null;
  detail?: string | null;
  progress?: number;
}

// Substrings meaning "refused on content/moderation grounds" — surfaced as a
// terminal, clear reason rather than a transient transport error.
const MODERATION_MARKERS = [
  "nsfw",
  "moderation",
  "safety",
  "content policy",
  "content_policy",
  "prohibited",
  "policy violation",
  "flagged",
  "blocked",
  "rejected",
];

function looksLikeModeration(text: string): boolean {
  const lower = text.toLowerCase();
  return MODERATION_MARKERS.some((m) => lower.includes(m));
}

// Pull a human-readable error out of Higgsfield's error shapes.
function extractError(body: HiggsfieldStatusResponse): string | undefined {
  const e = body.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e === "object" && typeof e.message === "string" && e.message.trim()) {
    return e.message.trim();
  }
  if (typeof body.detail === "string" && body.detail.trim()) return body.detail.trim();
  return undefined;
}

// Dig the finished video URL out of the various nesting shapes.
function resultVideoUrl(body: HiggsfieldStatusResponse): string | null {
  return (
    body.output?.video_url ??
    body.output?.url ??
    body.output?.video?.url ??
    body.video?.url ??
    body.result?.video_url ??
    body.result?.url ??
    null
  );
}

const TERMINAL_OK = new Set(["completed", "succeeded"]);
const TERMINAL_FAIL = new Set(["failed", "error", "canceled"]);

// Per-call network timeout. submit/poll are quick API calls; a hung connection
// must not hold the (cron) serverless function open. Mirrors the AbortController
// idiom used in lib/sources/* and lib/preview/scrape.ts. The mp4 fetchBytes
// download streams a larger body, so it passes a more generous budget.
const HF_FETCH_TIMEOUT_MS = 15_000;
const HF_DOWNLOAD_TIMEOUT_MS = 120_000;

async function hfFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Higgsfield request timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class HiggsfieldReferenceVideoProvider implements ReferenceVideoProvider {
  readonly name = "higgsfield_video";

  private base(): string {
    // higgsfieldBaseUrl() always returns a trimmed, slash-stripped URL.
    return higgsfieldBaseUrl();
  }

  // Higgsfield authenticates with a PAIR — an API Key ID and an API Key Secret,
  // sent as the `hf-api-key` + `hf-secret` headers. The shared provider contract
  // hands us a single string, so the orchestrator/cron pack the pair as
  // "<id>:<secret>"; we split on the FIRST colon (a secret may itself contain
  // colons). A value with no colon is treated as id-only (defensive).
  private authHeaders(apiKey: string): Record<string, string> {
    const sep = apiKey.indexOf(":");
    const id = sep >= 0 ? apiKey.slice(0, sep) : apiKey;
    const secret = sep >= 0 ? apiKey.slice(sep + 1) : "";
    return {
      "hf-api-key": id,
      "hf-secret": secret,
      "Content-Type": "application/json",
    };
  }

  // POST the generation. The avatar image is the reference photo; the script
  // (UGC voiceover copy) is preferred, falling back to the motion prompt. Returns
  // the Higgsfield job id (stored as the job's provider request id).
  async submit(input: ReferenceVideoInputs, apiKey: string): Promise<ReferenceVideoSubmitResult> {
    const body: Record<string, unknown> = {
      model: higgsfieldModel(),
      input_image_url: input.referenceImageUrl,
      // UGC content is script-driven; fall back to the motion prompt when no
      // script was supplied so a generation always has copy to work from.
      prompt: input.script?.trim() || input.prompt,
      aspect_ratio: input.aspect,
    };
    if (input.script?.trim()) body.script = input.script.trim();
    if (input.durationSeconds && input.durationSeconds > 0) {
      body.duration = Math.round(input.durationSeconds);
    }
    if (input.voiceId?.trim()) body.voice_id = input.voiceId.trim();

    const res = await hfFetch(
      `${this.base()}/v1/generations`,
      {
        method: "POST",
        headers: this.authHeaders(apiKey),
        body: JSON.stringify(body),
      },
      HF_FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      if (looksLikeModeration(text)) {
        throw new Error(`Higgsfield rejected the request on content policy: ${text.slice(0, 300)}`);
      }
      throw new Error(`Higgsfield submit failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as { id?: string; request_id?: string; data?: { id?: string } };
    const jobId = json.id ?? json.request_id ?? json.data?.id;
    if (!jobId) {
      throw new Error("Higgsfield submit returned no job id.");
    }
    return { providerJobId: jobId, provider: this.name };
  }

  // GET the generation status. queued/processing → processing; completed → ready
  // (with the video URL); failed/error → failed; moderation → failed with a clear
  // reason. Transient 5xx → processing so the cron retries instead of killing it.
  async poll(providerJobId: string, apiKey: string): Promise<ReferenceVideoPoll> {
    const res = await hfFetch(
      `${this.base()}/v1/generations/${encodeURIComponent(providerJobId)}`,
      { headers: this.authHeaders(apiKey) },
      HF_FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 422 || res.status === 400 || looksLikeModeration(text)) {
        return {
          status: "failed",
          failureReason: looksLikeModeration(text)
            ? `Rejected by Higgsfield content policy: ${text.slice(0, 300)}`
            : `Higgsfield status error (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      // Transient (5xx / rate limit) — keep processing; the cron's stale-guard
      // is the backstop against a render that never terminates.
      return { status: "processing" };
    }

    const body = (await res.json()) as HiggsfieldStatusResponse;
    const status = String(body.status ?? "").toLowerCase();

    const err = extractError(body);
    if (err || TERMINAL_FAIL.has(status)) {
      const reason = err ?? `Higgsfield reported status "${status}".`;
      return {
        status: "failed",
        failureReason: looksLikeModeration(reason)
          ? `Rejected by Higgsfield content policy: ${reason.slice(0, 300)}`
          : reason.slice(0, 300),
      };
    }

    if (TERMINAL_OK.has(status)) {
      const videoUrl = resultVideoUrl(body);
      if (!videoUrl) {
        return { status: "failed", failureReason: "Higgsfield completed but returned no video URL." };
      }
      return { status: "ready", progress: 100, videoUrl };
    }

    // queued / processing / unknown-but-non-terminal → still rendering.
    return {
      status: "processing",
      ...(typeof body.progress === "number" ? { progress: body.progress } : {}),
    };
  }

  // Pull the finished mp4. Higgsfield serves it from a CDN URL that can expire,
  // so the cron invokes this immediately on `ready` to own the asset — same
  // idiom as the fal/D-ID/HeyGen adapters.
  async fetchBytes(
    videoUrl: string,
    _apiKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await hfFetch(videoUrl, {}, HF_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`Higgsfield video fetch failed (${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "video/mp4";
    return { bytes, contentType };
  }
}

export const higgsfieldReferenceVideoProvider = new HiggsfieldReferenceVideoProvider();

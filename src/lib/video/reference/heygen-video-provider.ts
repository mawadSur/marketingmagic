// Reference-image video (bet ④ · Capability B "Make it talk") — HeyGen adapter.
//
// The SECOND talking-avatar provider, a DROP-IN alongside the D-ID adapter (same
// ReferenceVideoProvider contract, same submit → poll → fetchBytes shape onto the
// existing orchestrate→poll machinery). A user can choose D-ID or HeyGen for the
// 'present' render; the factory in stub-provider.ts selects between them. This is
// the TALKING-AVATAR path ("make the person in the uploaded photo speak a script",
// lip-synced) — distinct from BOTH the MPT Pexels-stitch pipeline AND the fal.ai
// image-to-video "animate a still" path (Capability A).
//
// HeyGen API shape (https://docs.heygen.com/ · §3b of the spike doc):
//   submit:  POST {HEYGEN_BASE_URL}/v2/video/generate
//              X-Api-Key: <key>
//              { video_inputs: [{
//                  character: { type:'talking_photo', talking_photo_id|photo_url },
//                  voice:     { type:'text', input_text, voice_id },
//                }],
//                dimension: { width, height } }
//              → { data: { video_id } }
//   poll:    GET  {HEYGEN_BASE_URL}/v1/video_status.get?video_id={id}
//              → { data: { status: pending|processing|completed|failed,
//                          video_url, error } }
//   result:  video_url on the `completed` payload (a CDN mp4 URL that can expire).
//
// Status mapping:
//   pending / processing / waiting  → processing
//   completed                       → ready (video_url)
//   failed                          → failed (provider reason surfaced; a
//                                     moderation/consent rejection flagged as such)
//
// CONSENT NOTE: like D-ID, this makes a REAL PERSON appear to speak words they may
// not have said. The orchestrator enforces a STRICTER consent attestation before
// any submit() runs here; this adapter additionally surfaces HeyGen's own
// moderation / rejection reason as a clean terminal failure rather than a silent
// dead job.
//
// The base URL + default voice are NOT hardcoded — they come from HEYGEN_BASE_URL /
// heygenDefaultVoiceId() in env.ts. Nothing here runs unless referenceVideoEnabled()
// is on (the factory in stub-provider.ts guards the flag before returning this
// adapter). Tests NEVER make a live call — fetch is mocked.

import { heygenBaseUrl, heygenDefaultVoiceId } from "@/lib/env";
import {
  type ReferenceVideoInputs,
  type ReferenceVideoPoll,
  type ReferenceVideoProvider,
  type ReferenceVideoSubmitResult,
} from "./provider";

// HeyGen video lifecycle states → our coarse status machine. (HeyGen reports
// pending → processing → completed/failed; "waiting" appears on some plans.)
type HeyGenVideoStatus = "pending" | "processing" | "waiting" | "completed" | "failed";

// Output pixel dimensions per aspect — HeyGen's /v2/video/generate takes an
// explicit { width, height } rather than an aspect token. 720p-class outputs.
const ASPECT_TO_DIMENSION: Record<ReferenceVideoInputs["aspect"], { width: number; height: number }> = {
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 1080, height: 1080 },
};

interface HeyGenSubmitResponse {
  // Success envelope nests the id under `data`.
  data?: { video_id?: string };
  // Error envelope — HeyGen returns a non-zero code + message on rejection.
  code?: number | string;
  message?: string;
  error?: { code?: string; message?: string } | string;
}

interface HeyGenPollResponse {
  data?: {
    status?: HeyGenVideoStatus | string;
    video_url?: string;
    // HeyGen surfaces a failure reason here (shape varies); tolerate all.
    error?: { code?: string; message?: string; detail?: string } | string;
  };
  code?: number | string;
  message?: string;
  error?: { code?: string; message?: string } | string;
}

// Substrings that mean "HeyGen refused this on content / moderation / consent
// grounds" — surfaced so the user understands it's a policy rejection (a real
// person's likeness used without the right consent), not a transient transport
// error. Mirrors the D-ID adapter's marker set.
const MODERATION_MARKERS = [
  "moderation",
  "content policy",
  "content_policy",
  "celebrity",
  "consent",
  "not allowed",
  "prohibited",
  "policy violation",
  "rejected",
  "blocked",
  "flagged",
  "nsfw",
  "safety",
  "unauthorized use",
  "likeness",
];

function looksLikeModeration(text: string): boolean {
  const lower = text.toLowerCase();
  return MODERATION_MARKERS.some((m) => lower.includes(m));
}

// Per-call network timeout. submit/poll are quick API calls; a hung connection
// must not hold the (cron) serverless function open. Mirrors the AbortController
// idiom used in lib/sources/* and lib/preview/scrape.ts. The mp4 fetchBytes
// download streams a larger body, so it passes a more generous budget.
const HEYGEN_FETCH_TIMEOUT_MS = 15_000;
const HEYGEN_DOWNLOAD_TIMEOUT_MS = 120_000;

async function heygenFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`HeyGen request timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Pull a human-readable error string out of HeyGen's various error shapes
// (top-level message, a nested data.error object/string, or a top-level error).
function extractError(body: HeyGenSubmitResponse | HeyGenPollResponse): string | undefined {
  const dataErr = (body as HeyGenPollResponse).data?.error;
  if (typeof dataErr === "string" && dataErr.trim()) return dataErr.trim();
  if (dataErr && typeof dataErr === "object") {
    const parts = [dataErr.code, dataErr.message, (dataErr as { detail?: string }).detail]
      .filter(Boolean)
      .join(": ");
    if (parts.trim()) return parts.trim();
  }
  const topErr = body.error;
  if (typeof topErr === "string" && topErr.trim()) return topErr.trim();
  if (topErr && typeof topErr === "object") {
    const parts = [topErr.code, topErr.message].filter(Boolean).join(": ");
    if (parts.trim()) return parts.trim();
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  return undefined;
}

export class HeyGenReferenceVideoProvider implements ReferenceVideoProvider {
  readonly name = "heygen_video";

  private generateEndpoint(): string {
    // heygenBaseUrl() is always set (env has a default), trailing slash trimmed
    // there, so the URL is well-formed without the caller knowing the host.
    return `${heygenBaseUrl()}/v2/video/generate`;
  }

  private statusEndpoint(videoId: string): string {
    return `${heygenBaseUrl()}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    // HeyGen auth is the `X-Api-Key` header (NOT a Bearer/Basic scheme). The BYO
    // key is the workspace's own HeyGen API key, presented verbatim.
    return {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // POST the talking-photo render. Returns the HeyGen video_id (stored as the
  // job's task id).
  async submit(input: ReferenceVideoInputs, apiKey: string): Promise<ReferenceVideoSubmitResult> {
    // Capability B REQUIRES a script — the words the avatar should speak. The
    // orchestrator already guards this, but we fail loudly here too (defence in
    // depth) so a scriptless talk can never be POSTed.
    const script = input.script?.trim();
    if (!script) {
      throw new Error("HeyGen talking-avatar requires a non-empty script.");
    }

    // HeyGen text-to-speech needs a real voice_id — there's no universal default
    // (ids are opaque + deployment-specific), so reject early rather than POST a
    // render HeyGen will reject. The deployment default (HEYGEN_DEFAULT_VOICE_ID)
    // covers the common case where the user doesn't pick one.
    const voiceId = input.voiceId?.trim() || heygenDefaultVoiceId();
    if (!voiceId) {
      throw new Error(
        "HeyGen talking-avatar requires a voice — pick a HeyGen voice id or set HEYGEN_DEFAULT_VOICE_ID.",
      );
    }

    const dimension = ASPECT_TO_DIMENSION[input.aspect] ?? ASPECT_TO_DIMENSION["9:16"];
    const body = {
      video_inputs: [
        {
          // The reference photo drives a talking_photo character. We pass the
          // public photo URL (HeyGen fetches it), the URL-based form of the
          // talking-photo character.
          character: {
            type: "talking_photo",
            photo_url: input.referenceImageUrl,
          },
          voice: {
            type: "text",
            input_text: script,
            voice_id: voiceId,
          },
        },
      ],
      dimension,
    };

    const res = await heygenFetch(
      this.generateEndpoint(),
      {
        method: "POST",
        headers: this.authHeaders(apiKey),
        body: JSON.stringify(body),
      },
      HEYGEN_FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      // A 4xx with a moderation/consent marker is a policy rejection (a real
      // person's likeness without the right consent), not a transport failure —
      // surface it as a clear, terminal reason.
      if (looksLikeModeration(text)) {
        throw new Error(`HeyGen rejected the request on content/consent policy: ${text.slice(0, 300)}`);
      }
      throw new Error(`HeyGen submit failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as HeyGenSubmitResponse;
    const id = json.data?.video_id;
    if (!id) {
      // HeyGen can 200 with an error envelope (non-zero code) instead of a
      // video_id on some rejections.
      const err = extractError(json);
      if (err && looksLikeModeration(err)) {
        throw new Error(`HeyGen rejected the request on content/consent policy: ${err.slice(0, 300)}`);
      }
      throw new Error(err ? `HeyGen submit error: ${err.slice(0, 300)}` : "HeyGen submit returned no video id.");
    }
    return { providerJobId: id, provider: this.name };
  }

  // GET the video status. Maps pending/processing/waiting → processing,
  // completed → ready (with video_url), failed → failed (provider reason
  // surfaced; moderation/consent flagged).
  async poll(providerJobId: string, apiKey: string): Promise<ReferenceVideoPoll> {
    const res = await heygenFetch(
      this.statusEndpoint(providerJobId),
      { headers: this.authHeaders(apiKey) },
      HEYGEN_FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      // A terminal moderation / 4xx on the status endpoint → failed, not retried.
      if ((res.status >= 400 && res.status < 500) || looksLikeModeration(text)) {
        return {
          status: "failed",
          failureReason: looksLikeModeration(text)
            ? `Rejected by HeyGen content/consent policy: ${text.slice(0, 300)}`
            : `HeyGen status error (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      // Other non-OK (5xx, transient) — treat as still processing so the cron
      // retries on the next tick rather than killing a live render.
      return { status: "processing" };
    }

    const body = (await res.json()) as HeyGenPollResponse;
    const status = body.data?.status;

    if (status === "completed") {
      const videoUrl = body.data?.video_url;
      if (!videoUrl) {
        return { status: "failed", failureReason: "HeyGen completed but returned no video_url." };
      }
      return { status: "ready", progress: 100, videoUrl };
    }

    if (status === "failed") {
      const reason = extractError(body) ?? "HeyGen render failed.";
      return {
        status: "failed",
        failureReason: looksLikeModeration(reason)
          ? `Rejected by HeyGen content/consent policy: ${reason.slice(0, 300)}`
          : reason.slice(0, 300),
      };
    }

    if (status === "pending" || status === "processing" || status === "waiting") {
      return { status: "processing" };
    }

    // Unknown status — keep it `processing` so we don't hard-fail a render on an
    // unrecognised string; the stale-guard in the cron is the backstop.
    return { status: "processing" };
  }

  // Pull the finished mp4. HeyGen serves video_url from a CDN URL that can expire,
  // so the caller (poll cron) invokes this immediately on `ready` to own the
  // asset — exactly like the D-ID / fal adapters do.
  async fetchBytes(
    videoUrl: string,
    _apiKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    // video_url is pre-signed; no auth header needed (mirrors the D-ID adapter).
    const res = await heygenFetch(videoUrl, {}, HEYGEN_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`HeyGen video fetch failed (${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "video/mp4";
    return { bytes, contentType };
  }
}

export const heygenReferenceVideoProvider = new HeyGenReferenceVideoProvider();

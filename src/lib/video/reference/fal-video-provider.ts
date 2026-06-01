// Reference-image video (bet ④) — fal.ai image-to-video adapter.
//
// Implements ReferenceVideoProvider against the fal.ai QUEUE API. This is the
// NEW image-conditioned generation path ("animate the user's uploaded photo
// into video"), distinct from the MPT Pexels-stitch pipeline. It mirrors the
// auth + pull-bytes idiom of src/lib/images/fal.ts (Authorization: Key <key>,
// then fetch the CDN URL immediately because it can expire), and maps 1:1 onto
// the existing submit → poll → fetchBytes orchestration.
//
// Queue API shape (https://fal.ai/models/.../image-to-video/api):
//   submit:  POST  https://queue.fal.run/{model}
//              { image_url, prompt, duration, aspect_ratio } → { request_id }
//   poll:    GET   https://queue.fal.run/{model}/requests/{id}/status
//              → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
//   result:  GET   https://queue.fal.run/{model}/requests/{id}
//              → { video: { url } }
//
// The model id is NOT hardcoded — it comes from REFERENCE_VIDEO_FAL_MODEL via
// referenceVideoFalModel() so the deployment picks the tier/model.
//
// Nothing here runs unless referenceVideoEnabled() is on (the factory in
// stub-provider.ts guards the flag before returning this adapter). Tests never
// make a live call — fetch is mocked / guarded.

import { referenceVideoFalModel } from "@/lib/env";
import {
  type ReferenceVideoInputs,
  type ReferenceVideoPoll,
  type ReferenceVideoProvider,
  type ReferenceVideoSubmitResult,
} from "./provider";

const QUEUE_BASE = "https://queue.fal.run";

// The interface's aspect vocabulary ("9:16"|"16:9"|"1:1") is already exactly the
// `aspect_ratio` Kling image-to-video accepts, so this is a pass-through. Kept
// explicit so a future model with a different vocabulary is a one-line change.
const ASPECT_TO_FAL: Record<ReferenceVideoInputs["aspect"], string> = {
  "9:16": "9:16",
  "16:9": "16:9",
  "1:1": "1:1",
};

// fal queue status strings → our coarse status machine.
type FalQueueStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

interface FalStatusResponse {
  status?: FalQueueStatus | string;
  // Some queue responses echo a percentage / logs; we surface progress when present.
  // (Kling reports no granular %, so this is best-effort.)
  queue_position?: number;
  // When the model fails on a content/safety policy, fal returns an error here
  // rather than a video. We map that to a clear `failed` reason.
  error?: string;
  detail?: string | { msg?: string }[];
}

interface FalResultResponse {
  video?: { url?: string };
  // Some hosted models nest the output; tolerate both shapes.
  output?: { video?: { url?: string } };
  error?: string;
  detail?: string;
}

// Substrings that mean "the provider refused this on content / moderation
// grounds" — surfaced verbatim-ish so the user understands it's a policy
// rejection, not a transient transport error.
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
];

function looksLikeModeration(text: string): boolean {
  const lower = text.toLowerCase();
  return MODERATION_MARKERS.some((m) => lower.includes(m));
}

// Pull a human-readable error string out of fal's various error shapes.
function extractError(body: { error?: string; detail?: unknown }): string | undefined {
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  const d = body.detail;
  if (typeof d === "string" && d.trim()) return d.trim();
  if (Array.isArray(d)) {
    const msg = d
      .map((e) => (e && typeof e === "object" && "msg" in e ? String((e as { msg: unknown }).msg) : ""))
      .filter(Boolean)
      .join("; ");
    if (msg) return msg;
  }
  return undefined;
}

export class FalReferenceVideoProvider implements ReferenceVideoProvider {
  readonly name = "fal_video";

  private endpoint(): string {
    // referenceVideoFalModel() is always set (env has a default), so the
    // endpoint is well-formed without the caller knowing the model.
    return `${QUEUE_BASE}/${referenceVideoFalModel()}`;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    // Identical auth header to src/lib/images/fal.ts (Authorization: Key <key>).
    return {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  // POST the render. Returns the fal request_id (stored as the job's task id).
  async submit(input: ReferenceVideoInputs, apiKey: string): Promise<ReferenceVideoSubmitResult> {
    const body: Record<string, unknown> = {
      image_url: input.referenceImageUrl,
      prompt: input.prompt,
      aspect_ratio: ASPECT_TO_FAL[input.aspect],
    };
    // fal Kling wants `duration` as a string of seconds ("5"/"10"); only send
    // when the caller specified one so the model applies its own default cap.
    if (input.durationSeconds && input.durationSeconds > 0) {
      body.duration = String(Math.round(input.durationSeconds));
    }

    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.authHeaders(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      // A 4xx with a moderation marker is a policy rejection, not a transport
      // failure — surface it as a clear, terminal reason.
      if (looksLikeModeration(text)) {
        throw new Error(`fal.ai rejected the request on content policy: ${text.slice(0, 300)}`);
      }
      throw new Error(`fal.ai submit failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as { request_id?: string };
    const requestId = json.request_id;
    if (!requestId) {
      throw new Error("fal.ai submit returned no request_id.");
    }
    return { providerJobId: requestId, provider: this.name };
  }

  // GET the queue status. Maps IN_QUEUE/IN_PROGRESS → processing, COMPLETED →
  // ready (fetching the result URL), and any error/moderation signal → failed.
  async poll(providerJobId: string, apiKey: string): Promise<ReferenceVideoPoll> {
    const statusUrl = `${this.endpoint()}/requests/${providerJobId}/status`;
    const res = await fetch(statusUrl, { headers: this.authHeaders(apiKey) });

    if (!res.ok) {
      const text = await res.text();
      // A terminal moderation/422 on the status endpoint → failed, not retried.
      if (res.status === 422 || looksLikeModeration(text)) {
        return {
          status: "failed",
          failureReason: looksLikeModeration(text)
            ? `Rejected by fal.ai content policy: ${text.slice(0, 300)}`
            : `fal.ai status error (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      // Other non-OK (5xx, transient) — treat as still processing so the cron
      // retries on the next tick rather than killing a live render.
      return { status: "processing" };
    }

    const body = (await res.json()) as FalStatusResponse;
    const status = body.status;

    // Any error payload alongside a status → terminal failure.
    const err = extractError(body);
    if (err) {
      return {
        status: "failed",
        failureReason: looksLikeModeration(err)
          ? `Rejected by fal.ai content policy: ${err.slice(0, 300)}`
          : err.slice(0, 300),
      };
    }

    if (status === "COMPLETED") {
      const videoUrl = await this.fetchResultUrl(providerJobId, apiKey);
      if (!videoUrl) {
        return { status: "failed", failureReason: "fal.ai completed but returned no video URL." };
      }
      return { status: "ready", progress: 100, videoUrl };
    }

    if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
      return { status: "processing" };
    }

    // Unknown status — keep it in `processing` so we don't hard-fail a render
    // on an unrecognised string; the stale-guard in the cron is the backstop.
    return { status: "processing" };
  }

  // GET the result envelope and dig out the mp4 URL. Separate so poll() stays
  // readable; called only on COMPLETED.
  private async fetchResultUrl(providerJobId: string, apiKey: string): Promise<string | null> {
    const resultUrl = `${this.endpoint()}/requests/${providerJobId}`;
    const res = await fetch(resultUrl, { headers: this.authHeaders(apiKey) });
    if (!res.ok) return null;
    const body = (await res.json()) as FalResultResponse;
    return body.video?.url ?? body.output?.video?.url ?? null;
  }

  // Pull the finished mp4. fal serves it from a CDN URL that can expire, so the
  // caller (poll cron) invokes this immediately on `ready` to own the asset —
  // exactly like images/fal.ts does for stills.
  async fetchBytes(
    videoUrl: string,
    _apiKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    // The CDN URL is pre-signed; no auth header needed (mirrors images/fal.ts).
    const res = await fetch(videoUrl);
    if (!res.ok) {
      throw new Error(`fal.ai video fetch failed (${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "video/mp4";
    return { bytes, contentType };
  }
}

export const falReferenceVideoProvider = new FalReferenceVideoProvider();

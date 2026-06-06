// Reference-image video (bet ④ · Capability B "Make it talk") — D-ID adapter.
//
// Implements ReferenceVideoProvider against the D-ID "Talks" API. This is the
// TALKING-AVATAR generation path ("make the person in the uploaded photo speak a
// script", lip-synced), distinct from BOTH the MPT Pexels-stitch pipeline AND
// the fal.ai image-to-video "animate a still" path (Capability A). It is a
// DROP-IN alongside the fal adapter — same ReferenceVideoProvider contract, same
// submit → poll → fetchBytes shape onto the existing orchestrate→poll machinery.
//
// Talks API shape (https://docs.d-id.com/ · §3c of the spike doc):
//   submit:  POST {DID_BASE_URL}/talks
//              Authorization: Basic <key>
//              { source_url, script: { type:'text', input, provider:{...voice} } }
//              → { id }
//   poll:    GET  {DID_BASE_URL}/talks/{id}
//              → { status: created|started|done|error|rejected, result_url, ... }
//   result:  result_url on the `done` payload (a CDN mp4 URL that can expire).
//
// Status mapping:
//   created / started  → processing
//   done               → ready (result_url)
//   error / rejected   → failed (provider reason surfaced verbatim-ish; a
//                        moderation/consent rejection is flagged as such).
//
// CONSENT NOTE: this path makes a REAL PERSON appear to speak words they may not
// have said. The orchestrator enforces a STRICTER consent attestation before any
// submit() runs here; this adapter additionally surfaces D-ID's own moderation /
// rejection reason as a clean terminal failure rather than a silent dead job.
//
// The base URL + default voice are NOT hardcoded — they come from DID_BASE_URL /
// didDefaultVoiceId() in env.ts. Nothing here runs unless referenceVideoEnabled()
// is on (the factory in stub-provider.ts guards the flag before returning this
// adapter). Tests NEVER make a live call — fetch is mocked.

import { didBaseUrl, didDefaultVoiceId } from "@/lib/env";
import {
  type ReferenceVideoInputs,
  type ReferenceVideoPoll,
  type ReferenceVideoProvider,
  type ReferenceVideoSubmitResult,
} from "./provider";

// D-ID talk lifecycle states → our coarse status machine.
type DidTalkStatus = "created" | "started" | "done" | "error" | "rejected";

interface DidSubmitResponse {
  id?: string;
  // D-ID echoes an error object on a synchronous rejection (e.g. bad source_url,
  // moderation refusal) instead of an id.
  kind?: string;
  description?: string;
  message?: string;
}

interface DidPollResponse {
  status?: DidTalkStatus | string;
  result_url?: string;
  // On error/rejected D-ID returns a reason here (shape varies); tolerate all.
  error?: { kind?: string; description?: string } | string;
  kind?: string;
  description?: string;
  message?: string;
}

// Substrings that mean "D-ID refused this on content / moderation / consent
// grounds" — surfaced so the user understands it's a policy rejection (a real
// person's likeness used without the right consent), not a transient transport
// error.
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
];

function looksLikeModeration(text: string): boolean {
  const lower = text.toLowerCase();
  return MODERATION_MARKERS.some((m) => lower.includes(m));
}

// Per-call network timeout. submit/poll are quick API calls; a hung connection
// must not hold the (cron) serverless function open. Mirrors the AbortController
// idiom used in lib/sources/* and lib/preview/scrape.ts. The mp4 fetchBytes
// download streams a larger body, so it passes a more generous budget.
const DID_FETCH_TIMEOUT_MS = 15_000;
const DID_DOWNLOAD_TIMEOUT_MS = 120_000;

async function didFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`D-ID request timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Pull a human-readable error string out of D-ID's various error shapes
// (top-level description/message, or a nested error object/string).
function extractError(body: DidPollResponse | DidSubmitResponse): string | undefined {
  const b = body as DidPollResponse;
  if (typeof b.error === "string" && b.error.trim()) return b.error.trim();
  if (b.error && typeof b.error === "object") {
    const parts = [b.error.kind, b.error.description].filter(Boolean).join(": ");
    if (parts.trim()) return parts.trim();
  }
  if (typeof b.description === "string" && b.description.trim()) return b.description.trim();
  if (typeof b.message === "string" && b.message.trim()) return b.message.trim();
  if (typeof b.kind === "string" && b.kind.trim()) return b.kind.trim();
  return undefined;
}

export class DIdReferenceVideoProvider implements ReferenceVideoProvider {
  readonly name = "did_video";

  private endpoint(): string {
    // didBaseUrl() is always set (env has a default), trailing slash trimmed
    // there, so the URL is well-formed without the caller knowing the host.
    return `${didBaseUrl()}/talks`;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    // D-ID auth is `Authorization: Basic <key>`. The BYO key is the workspace's
    // own D-ID API key, already in the form D-ID expects (a base64
    // username:password or an api-key:secret). We do NOT re-encode it — D-ID
    // keys are presented verbatim after "Basic ".
    return {
      Authorization: `Basic ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // POST the talk render. Returns the D-ID talk id (stored as the job's task id).
  async submit(input: ReferenceVideoInputs, apiKey: string): Promise<ReferenceVideoSubmitResult> {
    // Capability B REQUIRES a script — the words the avatar should speak. The
    // orchestrator already guards this, but we fail loudly here too (defence in
    // depth) so a scriptless talk can never be POSTed.
    const script = input.script?.trim();
    if (!script) {
      throw new Error("D-ID talking-avatar requires a non-empty script.");
    }

    const body = {
      source_url: input.referenceImageUrl,
      script: {
        type: "text",
        input: script,
        provider: {
          type: "microsoft",
          voice_id: input.voiceId?.trim() || didDefaultVoiceId(),
        },
      },
    };

    const res = await didFetch(
      this.endpoint(),
      {
        method: "POST",
        headers: this.authHeaders(apiKey),
        body: JSON.stringify(body),
      },
      DID_FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      const text = await res.text();
      // A 4xx with a moderation/consent marker is a policy rejection (a real
      // person's likeness without the right consent), not a transport failure —
      // surface it as a clear, terminal reason.
      if (looksLikeModeration(text)) {
        throw new Error(`D-ID rejected the request on content/consent policy: ${text.slice(0, 300)}`);
      }
      throw new Error(`D-ID submit failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as DidSubmitResponse;
    const id = json.id;
    if (!id) {
      // D-ID can 200 with an error envelope instead of an id on some rejections.
      const err = extractError(json);
      if (err && looksLikeModeration(err)) {
        throw new Error(`D-ID rejected the request on content/consent policy: ${err.slice(0, 300)}`);
      }
      throw new Error(err ? `D-ID submit error: ${err.slice(0, 300)}` : "D-ID submit returned no talk id.");
    }
    return { providerJobId: id, provider: this.name };
  }

  // GET the talk status. Maps created/started → processing, done → ready (with
  // result_url), error/rejected → failed (provider reason surfaced).
  async poll(providerJobId: string, apiKey: string): Promise<ReferenceVideoPoll> {
    const statusUrl = `${this.endpoint()}/${providerJobId}`;
    const res = await didFetch(statusUrl, { headers: this.authHeaders(apiKey) }, DID_FETCH_TIMEOUT_MS);

    if (!res.ok) {
      const text = await res.text();
      // A terminal moderation / 4xx on the status endpoint → failed, not retried.
      if ((res.status >= 400 && res.status < 500) || looksLikeModeration(text)) {
        return {
          status: "failed",
          failureReason: looksLikeModeration(text)
            ? `Rejected by D-ID content/consent policy: ${text.slice(0, 300)}`
            : `D-ID status error (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      // Other non-OK (5xx, transient) — treat as still processing so the cron
      // retries on the next tick rather than killing a live render.
      return { status: "processing" };
    }

    const body = (await res.json()) as DidPollResponse;
    const status = body.status;

    if (status === "done") {
      const videoUrl = body.result_url;
      if (!videoUrl) {
        return { status: "failed", failureReason: "D-ID completed but returned no result_url." };
      }
      return { status: "ready", progress: 100, videoUrl };
    }

    if (status === "error" || status === "rejected") {
      const reason = extractError(body) ?? `D-ID render ${status}.`;
      return {
        status: "failed",
        failureReason: looksLikeModeration(reason)
          ? `Rejected by D-ID content/consent policy: ${reason.slice(0, 300)}`
          : reason.slice(0, 300),
      };
    }

    if (status === "created" || status === "started") {
      return { status: "processing" };
    }

    // Unknown status — keep it `processing` so we don't hard-fail a render on an
    // unrecognised string; the stale-guard in the cron is the backstop.
    return { status: "processing" };
  }

  // Pull the finished mp4. D-ID serves result_url from a CDN URL that can expire,
  // so the caller (poll cron) invokes this immediately on `ready` to own the
  // asset — exactly like the fal adapter / images/fal.ts do.
  async fetchBytes(
    videoUrl: string,
    _apiKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    // result_url is pre-signed; no auth header needed (mirrors the fal adapter).
    const res = await didFetch(videoUrl, {}, DID_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`D-ID video fetch failed (${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "video/mp4";
    return { bytes, contentType };
  }
}

export const didReferenceVideoProvider = new DIdReferenceVideoProvider();

// Threads via Meta Graph API.
//
// Two-step post: create a media container, then publish it.
// Auth: long-lived user access token with `threads_basic` + `threads_content_publish`.

import { serverEnv } from "@/lib/env";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import { RetryableError } from "./errors";

export interface ThreadsCredentials {
  accessToken: string;
  expiresAt: string;
  userId: string; // numeric IG/Threads user id
}

const GRAPH = "https://graph.threads.net/v1.0";

export interface ThreadsPostResult {
  id: string;
}

export interface ThreadsMetrics {
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function threadsAuthorizeUrl(opts: { redirectUri: string; state: string }): string {
  const env = serverEnv();
  if (!env.THREADS_APP_ID) {
    throw new Error("THREADS_APP_ID is not set.");
  }
  const params = new URLSearchParams({
    client_id: env.THREADS_APP_ID,
    redirect_uri: opts.redirectUri,
    scope: "threads_basic,threads_content_publish,threads_manage_insights",
    response_type: "code",
    state: opts.state,
  });
  return `https://threads.net/oauth/authorize?${params}`;
}

export async function threadsExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; userId: string; expiresAt: string }> {
  const env = serverEnv();
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    throw new Error("Threads OAuth keys are not set.");
  }
  // Short-lived token first.
  const shortRes = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.THREADS_APP_ID,
      client_secret: env.THREADS_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
      code: opts.code,
    }),
  });
  if (!shortRes.ok) {
    throw new Error(`Threads short token failed (${shortRes.status}): ${await shortRes.text()}`);
  }
  const short = (await shortRes.json()) as { access_token: string; user_id: string };

  // Exchange for long-lived (60-day) token.
  const longRes = await fetch(
    `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`,
  );
  if (!longRes.ok) {
    throw new Error(`Threads long token failed (${longRes.status}): ${await longRes.text()}`);
  }
  const long = (await longRes.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: long.access_token,
    userId: short.user_id,
    expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(),
  };
}

export async function threadsVerify(
  accessToken: string,
  userId: string,
): Promise<{ username: string }> {
  const res = await fetch(`${GRAPH}/${userId}?fields=username&access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) {
    throw new Error(`Threads verify failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { username: string };
  return { username: json.username };
}

// ─── Posting ───────────────────────────────────────────────────────────────

export async function threadsPost(
  creds: ThreadsCredentials,
  text: string,
  imageUrl?: string,
): Promise<ThreadsPostResult> {
  // Step 1: create the media container.
  const containerParams = new URLSearchParams({
    access_token: creds.accessToken,
    media_type: imageUrl ? "IMAGE" : "TEXT",
    text,
  });
  if (imageUrl) containerParams.set("image_url", imageUrl);

  const containerRes = await fetch(`${GRAPH}/${creds.userId}/threads?${containerParams}`, {
    method: "POST",
  });
  if (!containerRes.ok) {
    throw new Error(`Threads container failed (${containerRes.status}): ${await containerRes.text()}`);
  }
  const { id: containerId } = (await containerRes.json()) as { id: string };

  // Step 2: publish. IMAGE containers process server-side; poll the container
  // to FINISHED instead of a blind fixed sleep so we publish as soon as it's
  // ready (and surface a real error if Meta rejects the media).
  if (imageUrl) {
    await pollContainerStatus(containerId, creds.accessToken, {
      // Images finish in a few seconds; keep the budget tight.
      initialDelayMs: 0,
      intervalMs: 3000,
      timeoutMs: 60 * 1000,
    });
  }
  return publishContainer(creds, containerId);
}

// Shared publish step: POST threads_publish with the container's creation_id.
async function publishContainer(
  creds: ThreadsCredentials,
  containerId: string,
): Promise<ThreadsPostResult> {
  const pubRes = await fetch(
    `${GRAPH}/${creds.userId}/threads_publish?creation_id=${containerId}&access_token=${encodeURIComponent(creds.accessToken)}`,
    { method: "POST" },
  );
  if (!pubRes.ok) {
    throw new Error(`Threads publish failed (${pubRes.status}): ${await pubRes.text()}`);
  }
  const pub = (await pubRes.json()) as { id: string };
  return { id: pub.id };
}

// ─── Video ───────────────────────────────────────────────────────────────────
//
// Threads ingests video by URL-pull (same as images): create a VIDEO container
// pointing at the public Storage URL, wait for Meta's async transcode to reach
// FINISHED, then publish. Video transcode is much slower than images, so Meta
// recommends waiting ≥30s before the first status check, then polling ~1/min.

export async function threadsPostVideo(
  creds: ThreadsCredentials,
  text: string,
  videoUrl: string,
): Promise<ThreadsPostResult> {
  if (!videoUrl) throw new Error("Threads video post requires a public video URL.");
  // Step 1: create the VIDEO container.
  const containerParams = new URLSearchParams({
    access_token: creds.accessToken,
    media_type: "VIDEO",
    video_url: videoUrl,
    text,
  });
  const containerRes = await fetch(`${GRAPH}/${creds.userId}/threads?${containerParams}`, {
    method: "POST",
  });
  if (!containerRes.ok) {
    throw new Error(
      `Threads video container failed (${containerRes.status}): ${await containerRes.text()}`,
    );
  }
  const { id: containerId } = (await containerRes.json()) as { id: string };

  // Step 2: poll to FINISHED. Wait ≥30s before the first check (Meta's
  // guidance), then poll ~1/min up to ~5min.
  await pollContainerStatus(containerId, creds.accessToken, {
    initialDelayMs: 30 * 1000,
    intervalMs: 60 * 1000,
    timeoutMs: 5 * 60 * 1000,
  });

  // Step 3: publish.
  return publishContainer(creds, containerId);
}

// Poll a Threads media container's processing status to a terminal state.
// Returns on FINISHED, throws on ERROR/EXPIRED, and throws a RetryableError if
// the time budget is exhausted so the cron leaves the post `scheduled` and
// retries on the next tick rather than failing a transcode still in progress.
//
// Hardening path (NOT built now): persist the container id on the post row at
// creation time and, on a later tick, resume from this poll + publish instead
// of re-creating the container — avoids a duplicate URL-pull for a single slow
// transcode.
async function pollContainerStatus(
  containerId: string,
  token: string,
  opts: { initialDelayMs: number; intervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  if (opts.initialDelayMs > 0) {
    await new Promise((r) => setTimeout(r, opts.initialDelayMs));
  }
  for (;;) {
    const res = await fetch(
      `${GRAPH}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      throw new Error(`Threads container status failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { status?: string; error_message?: string };
    const state = json.status;
    if (state === "FINISHED") return;
    if (state === "ERROR" || state === "EXPIRED") {
      throw new Error(
        `Threads media processing failed (status=${state})${
          json.error_message ? `: ${json.error_message}` : ""
        }.`,
      );
    }
    // IN_PROGRESS (or PUBLISHED, which shouldn't happen pre-publish) → keep going.
    if (Date.now() + opts.intervalMs >= deadline) {
      throw new RetryableError(
        `Threads container ${containerId} still processing after ${Math.round(
          opts.timeoutMs / 1000,
        )}s; will retry next tick.`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export async function threadsMetrics(
  creds: ThreadsCredentials,
  mediaId: string,
): Promise<ThreadsMetrics> {
  const metrics = "views,likes,replies,reposts,quotes";
  const res = await fetch(
    `${GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(creds.accessToken)}`,
  );
  if (!res.ok) {
    throw new Error(`Threads metrics failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data: Array<{ name: string; values: Array<{ value: number }> }> };
  const map = new Map<string, number>();
  for (const m of json.data ?? []) {
    map.set(m.name, m.values?.[0]?.value ?? 0);
  }
  return {
    impressions: map.get("views") ?? 0,
    likes: map.get("likes") ?? 0,
    replies: map.get("replies") ?? 0,
    reposts: map.get("reposts") ?? 0,
    quotes: map.get("quotes") ?? 0,
  };
}

// ─── Phase 4.5 (Reply Inbox + Engagement Assistant) ─────────────────────
//
// Stubs only. The Threads reply + reply-listing endpoints require the
// `threads_manage_replies` scope, which is gated on Meta App Review.
// Like the Instagram pair, we expose the helpers so call sites
// type-check but every call throws MetaAppReviewPendingError.

export async function threadsListReplies(
  _creds: ThreadsCredentials,
  _mediaId: string,
  _count = 25,
): Promise<never> {
  throw new MetaAppReviewPendingError("threads_manage_replies");
}

export async function threadsReply(
  _creds: ThreadsCredentials,
  _replyText: string,
  _parentMediaId: string,
): Promise<never> {
  throw new MetaAppReviewPendingError("threads_manage_replies");
}

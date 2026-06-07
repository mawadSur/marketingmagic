// Bluesky via AT Protocol. App-password auth (no OAuth app review).
//
// Sessions live ~2 hours; we re-issue on every call to keep it simple.
// Credentials shape: { handle, appPassword }
// Service: https://bsky.social (default PDS — could be parameterized later).

import { RetryableError } from "./errors";
import { DmScopeMissingError } from "@/lib/interactions/errors";

export interface BlueskyCredentials {
  handle: string; // e.g. "marketingmagic.bsky.social"
  appPassword: string;
}

const SERVICE = "https://bsky.social";
// The dedicated video service that ingests, transcodes, and serves blobs for
// app.bsky.embed.video. It's a SEPARATE host from the PDS (bsky.social) with
// its own service DID (did:web:video.bsky.app).
const VIDEO_SERVICE = "https://video.bsky.app";
const VIDEO_SERVICE_DID = "did:web:video.bsky.app";

// Per-call network timeout. XRPC calls (session, createRecord, blob upload,
// metrics) are quick; a hung connection must not hold a serverless function
// open. Mirrors the AbortController idiom used in lib/sources/* and
// lib/preview/scrape.ts. The raw-video PUT streams the whole file, so callers
// pass a more generous budget via `timeoutMs`.
const BSKY_FETCH_TIMEOUT_MS = 20_000;
const BSKY_UPLOAD_TIMEOUT_MS = 120_000;

async function bskyFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = BSKY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Bluesky request timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
}

async function createSession(creds: BlueskyCredentials): Promise<Session> {
  const res = await bskyFetch(`${SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: creds.handle, password: creds.appPassword }),
  });
  if (!res.ok) throw new Error(`Bluesky session failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as Session;
}

export interface BlueskyPostResult {
  uri: string; // at://did:plc:.../app.bsky.feed.post/...
  cid: string;
}

export interface BlueskyMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
}

export async function blueskyVerify(creds: BlueskyCredentials): Promise<{ handle: string; did: string }> {
  const session = await createSession(creds);
  return { handle: creds.handle, did: session.did };
}

export async function blueskyPost(
  creds: BlueskyCredentials,
  text: string,
  image?: { bytes: Uint8Array; contentType: string; alt?: string },
): Promise<BlueskyPostResult> {
  const session = await createSession(creds);

  // Optional: upload image blob first.
  let embed: Record<string, unknown> | undefined;
  if (image) {
    const upRes = await bskyFetch(`${SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": image.contentType,
      },
      body: image.bytes as BlobPart,
    });
    if (!upRes.ok) throw new Error(`Bluesky uploadBlob failed (${upRes.status}): ${await upRes.text()}`);
    const blob = (await upRes.json()) as { blob: unknown };
    embed = {
      $type: "app.bsky.embed.images",
      images: [{ alt: image.alt ?? "", image: blob.blob }],
    };
  }

  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    ...(embed ? { embed } : {}),
  };
  const createRes = await bskyFetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
  });
  if (!createRes.ok) throw new Error(`Bluesky create failed (${createRes.status}): ${await createRes.text()}`);
  const json = (await createRes.json()) as { uri: string; cid: string };
  return json;
}

// ─── Video (byte upload via video.bsky.app) ──────────────────────────────────
//
// Bluesky video is genuinely shippable today — no app review, just a connected
// account whose email is verified. The flow has four signed-token gotchas worth
// the comments:
//   1. Preflight getUploadLimits with a service-auth token minted for the VIDEO
//      service DID. If canUpload is false we abort early with a clear reason
//      (unverified email / daily cap) instead of a cryptic 4xx mid-upload.
//   2. The actual upload token must be minted for the user's *PDS* DID with lxm
//      = com.atproto.repo.uploadBlob — NOT app.bsky.video.uploadVideo. Using
//      the wrong lxm is the #1 cause of a 401 here.
//   3. uploadVideo returns a jobId; we poll getJobStatus until COMPLETED, which
//      yields the blob ref to embed.
//   4. createRecord uses the *normal session accessJwt* (not a service token).

const VIDEO_POLL_INTERVAL_MS = 1500; // ~1/s, slightly relaxed
const VIDEO_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap

interface VideoBlobRef {
  $type?: string;
  ref?: unknown;
  mimeType?: string;
  size?: number;
}

export async function blueskyPostVideo(
  creds: BlueskyCredentials,
  text: string,
  video: {
    bytes: Uint8Array;
    contentType: string; // expected "video/mp4"
    alt?: string;
    aspectRatio?: { width: number; height: number };
  },
): Promise<BlueskyPostResult> {
  const session = await createSession(creds);

  // 1. Preflight: can this account upload at all right now?
  const limitsToken = await getServiceAuth(
    session.accessJwt,
    VIDEO_SERVICE_DID,
    "app.bsky.video.getUploadLimits",
  );
  const limitsRes = await bskyFetch(
    `${VIDEO_SERVICE}/xrpc/app.bsky.video.getUploadLimits`,
    { headers: { Authorization: `Bearer ${limitsToken}` } },
  );
  if (!limitsRes.ok) {
    throw new Error(
      `Bluesky getUploadLimits failed (${limitsRes.status}): ${await limitsRes.text()}`,
    );
  }
  const limits = (await limitsRes.json()) as {
    canUpload?: boolean;
    message?: string;
    remainingDailyVideos?: number;
  };
  if (limits.canUpload === false) {
    throw new Error(
      `Bluesky won't accept this video: ${
        limits.message ??
        "upload not allowed (verify the account's email, or the daily video limit may be reached)."
      }`,
    );
  }

  // 2. Resolve the account's PDS DID and mint an upload token scoped to it.
  const pdsDid = await resolvePdsDid(session.did);
  const uploadToken = await getServiceAuth(
    session.accessJwt,
    pdsDid,
    "com.atproto.repo.uploadBlob",
  );

  // 3. Upload the raw bytes → jobId. Name must be unique per upload.
  const name = `mm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const uploadUrl = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.set("did", session.did);
  uploadUrl.searchParams.set("name", name);
  const upRes = await bskyFetch(
    uploadUrl.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "video/mp4",
        "Content-Length": String(video.bytes.byteLength),
      },
      body: video.bytes as BlobPart,
    },
    BSKY_UPLOAD_TIMEOUT_MS,
  );
  if (!upRes.ok) {
    throw new Error(`Bluesky uploadVideo failed (${upRes.status}): ${await upRes.text()}`);
  }
  const upJson = (await upRes.json()) as { jobId?: string; jobStatus?: { jobId?: string } };
  const jobId = upJson.jobId ?? upJson.jobStatus?.jobId;
  if (!jobId) throw new Error("Bluesky uploadVideo returned no jobId.");

  // 4. Poll the transcode job to COMPLETED → blob ref.
  const blob = await pollJobStatus(jobId);

  // 5. Create the post with an app.bsky.embed.video embed using the normal
  //    session accessJwt (NOT a service token).
  const embed: Record<string, unknown> = {
    $type: "app.bsky.embed.video",
    video: blob,
    ...(video.alt ? { alt: video.alt } : {}),
    ...(video.aspectRatio ? { aspectRatio: video.aspectRatio } : {}),
  };
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    embed,
  };
  const createRes = await bskyFetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
  });
  if (!createRes.ok) {
    throw new Error(`Bluesky video create failed (${createRes.status}): ${await createRes.text()}`);
  }
  return (await createRes.json()) as BlueskyPostResult;
}

// Mint a short-lived service-auth JWT (com.atproto.server.getServiceAuth) the
// caller can present to a DIFFERENT service (video.bsky.app or the PDS). `aud`
// is the target service's DID; `lxm` scopes the token to one XRPC method.
async function getServiceAuth(
  accessJwt: string,
  aud: string,
  lxm: string,
  exp?: number,
): Promise<string> {
  const url = new URL(`${SERVICE}/xrpc/com.atproto.server.getServiceAuth`);
  url.searchParams.set("aud", aud);
  url.searchParams.set("lxm", lxm);
  // Default ~5 min expiry — long enough for an upload, short enough to be safe.
  url.searchParams.set("exp", String(exp ?? Math.floor(Date.now() / 1000) + 60 * 5));
  const res = await bskyFetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessJwt}` },
  });
  if (!res.ok) {
    throw new Error(`Bluesky getServiceAuth failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("Bluesky getServiceAuth returned no token.");
  return json.token;
}

// Resolve a repo DID to its PDS service DID (did:web:<pds-host>). We read the
// DID document from plc.directory (did:plc:*) or the did:web URL, find the
// AtprotoPersonalDataServer service endpoint, and derive did:web from its host.
async function resolvePdsDid(did: string): Promise<string> {
  let docUrl: string;
  if (did.startsWith("did:plc:")) {
    docUrl = `https://plc.directory/${did}`;
  } else if (did.startsWith("did:web:")) {
    docUrl = `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  } else {
    throw new Error(`Bluesky: unsupported DID method for PDS resolution: ${did}`);
  }
  const res = await bskyFetch(docUrl);
  if (!res.ok) {
    throw new Error(`Bluesky DID doc fetch failed (${res.status}): ${await res.text()}`);
  }
  const doc = (await res.json()) as {
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
  };
  const pds = (doc.service ?? []).find(
    (s) => s.type === "AtprotoPersonalDataServer" || s.id === "#atproto_pds",
  );
  if (!pds?.serviceEndpoint) {
    throw new Error("Bluesky: no PDS service endpoint in DID document.");
  }
  const host = new URL(pds.serviceEndpoint).host;
  return `did:web:${host}`;
}

// Poll app.bsky.video.getJobStatus to a terminal state. Returns the blob ref on
// JOB_STATE_COMPLETED, throws on JOB_STATE_FAILED, and throws RetryableError if
// the time budget is exhausted so the cron retries on the next tick.
//
// Hardening path (NOT built now): persist jobId on the post row and resume this
// poll on a later tick rather than re-uploading the bytes.
async function pollJobStatus(jobId: string): Promise<VideoBlobRef> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  for (;;) {
    const url = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus`);
    url.searchParams.set("jobId", jobId);
    const res = await bskyFetch(url.toString());
    if (!res.ok) {
      throw new Error(`Bluesky getJobStatus failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      jobStatus?: { state?: string; blob?: VideoBlobRef; error?: string; message?: string };
    };
    const state = json.jobStatus?.state;
    if (state === "JOB_STATE_COMPLETED") {
      const blob = json.jobStatus?.blob;
      if (!blob) throw new Error("Bluesky job completed but returned no blob.");
      return blob;
    }
    if (state === "JOB_STATE_FAILED") {
      throw new Error(
        `Bluesky video processing failed${
          json.jobStatus?.error ? `: ${json.jobStatus.error}` : ""
        }.`,
      );
    }
    if (Date.now() + VIDEO_POLL_INTERVAL_MS >= deadline) {
      throw new RetryableError(
        `Bluesky video job ${jobId} still processing after ${Math.round(
          VIDEO_POLL_TIMEOUT_MS / 1000,
        )}s; will retry next tick.`,
      );
    }
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
  }
}

export async function blueskyMetrics(
  creds: BlueskyCredentials,
  postUri: string,
): Promise<BlueskyMetrics> {
  const session = await createSession(creds);
  // getPostThread returns the post with attached counts.
  const res = await bskyFetch(
    `${SERVICE}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=0`,
    { headers: { Authorization: `Bearer ${session.accessJwt}` } },
  );
  if (!res.ok) throw new Error(`Bluesky metrics failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    thread: {
      post: {
        likeCount?: number;
        repostCount?: number;
        replyCount?: number;
        quoteCount?: number;
      };
    };
  };
  const p = json.thread?.post ?? {};
  return {
    likes: p.likeCount ?? 0,
    reposts: p.repostCount ?? 0,
    replies: p.replyCount ?? 0,
    quotes: p.quoteCount ?? 0,
  };
}

// ─── Phase 6.6 (Competitor Watch) ───────────────────────────────────────
//
// Public-read access to an actor's recent posts via app.bsky.feed.getAuthorFeed
// on https://public.api.bsky.app. Unauthenticated; the Bluesky AppView
// publishes this XRPC endpoint as genuinely public. Returns full post
// objects (counts + ids + URLs), not just text.

export interface BlueskyAuthorPost {
  uri: string; // at://did:plc:.../app.bsky.feed.post/{rkey}
  cid: string;
  text: string;
  createdAt: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
}

const BSKY_PUBLIC_FEED = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";

export async function blueskyGetAuthorFeed(
  actor: string,
  limit = 30,
): Promise<BlueskyAuthorPost[]> {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const url = new URL(BSKY_PUBLIC_FEED);
  url.searchParams.set("actor", actor);
  url.searchParams.set("limit", String(bounded));
  url.searchParams.set("filter", "posts_no_replies");

  const res = await bskyFetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "marketingmagic-competitors/1.0" },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = new Error(`Bluesky author feed failed (${res.status}): ${await res.text()}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const json = (await res.json()) as { feed?: unknown };
  const items = Array.isArray(json.feed) ? json.feed : [];
  const out: BlueskyAuthorPost[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const post = (item as { post?: Record<string, unknown> }).post;
    if (!post || typeof post !== "object") continue;
    const record = post.record as { text?: unknown; createdAt?: unknown } | undefined;
    const uri = post.uri;
    const cid = post.cid;
    if (typeof uri !== "string" || typeof cid !== "string") continue;
    const text = typeof record?.text === "string" ? record.text : "";
    const createdAt = typeof record?.createdAt === "string" ? record.createdAt : "";
    if (!createdAt) continue;
    out.push({
      uri,
      cid,
      text,
      createdAt,
      likeCount: typeof post.likeCount === "number" ? post.likeCount : 0,
      repostCount: typeof post.repostCount === "number" ? post.repostCount : 0,
      replyCount: typeof post.replyCount === "number" ? post.replyCount : 0,
      quoteCount: typeof post.quoteCount === "number" ? post.quoteCount : 0,
    });
  }
  return out;
}

// ─── Phase 4.5 (Reply Inbox + Engagement Assistant) ─────────────────────
//
// blueskyReply — post a reply to a parent post via createRecord with a
// `reply` field. The parent ref needs both the AT-URI and CID of the
// root and the immediate parent. For top-level replies (parent == root)
// we pass the same values for both.
//
// blueskyListNotifications — pull the authed account's recent
// notifications (mentions, replies, quotes) via
// app.bsky.notification.listNotifications. We filter to mention + reply
// in the poller.

export interface BlueskyReplyResult {
  uri: string;
  cid: string;
}

export interface BlueskyParentRef {
  uri: string;
  cid: string;
}

export async function blueskyReply(
  creds: BlueskyCredentials,
  replyText: string,
  // Caller must pass both root + parent; for a one-level reply they're
  // identical. The notifications endpoint returns root info on each
  // notification record, so the poller can wire this up.
  parent: BlueskyParentRef,
  root: BlueskyParentRef = parent,
): Promise<BlueskyReplyResult> {
  const session = await createSession(creds);
  const record = {
    $type: "app.bsky.feed.post",
    text: replyText,
    createdAt: new Date().toISOString(),
    reply: { root, parent },
  };
  const res = await bskyFetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
  });
  if (!res.ok) {
    throw new Error(`Bluesky reply failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as BlueskyReplyResult;
}

export interface BlueskyInboundNotification {
  uri: string; // notification's at-uri (used as our external_id)
  cid: string;
  reason: "like" | "repost" | "follow" | "mention" | "reply" | "quote" | string;
  authorHandle: string;
  authorDisplayName: string | null;
  // Only present on mention / reply / quote; null on like / follow.
  text: string | null;
  // For replies — the parent URI we're replying to. NULL on mentions.
  parentUri: string | null;
  parentCid: string | null;
  // Root of the thread (same as parent for one-level replies).
  rootUri: string | null;
  rootCid: string | null;
  createdAt: string;
  isRead: boolean;
}

export async function blueskyListNotifications(
  creds: BlueskyCredentials,
  limit = 30,
): Promise<BlueskyInboundNotification[]> {
  const session = await createSession(creds);
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const url = `${SERVICE}/xrpc/app.bsky.notification.listNotifications?limit=${bounded}`;
  const res = await bskyFetch(url, {
    headers: { Authorization: `Bearer ${session.accessJwt}` },
  });
  if (!res.ok) {
    const err = new Error(`Bluesky notifications failed (${res.status}): ${await res.text()}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as { notifications?: unknown[] };
  const items = Array.isArray(body.notifications) ? body.notifications : [];
  const out: BlueskyInboundNotification[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const uri = typeof n.uri === "string" ? n.uri : null;
    const cid = typeof n.cid === "string" ? n.cid : null;
    const reason = typeof n.reason === "string" ? n.reason : "";
    const indexedAt = typeof n.indexedAt === "string" ? n.indexedAt : null;
    if (!uri || !cid || !indexedAt) continue;
    const author = n.author as
      | { handle?: unknown; displayName?: unknown }
      | undefined;
    const record = (n.record ?? {}) as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : null;
    const reply = record.reply as
      | {
          parent?: { uri?: unknown; cid?: unknown };
          root?: { uri?: unknown; cid?: unknown };
        }
      | undefined;
    out.push({
      uri,
      cid,
      reason,
      authorHandle:
        typeof author?.handle === "string" ? author.handle : "unknown",
      authorDisplayName:
        typeof author?.displayName === "string" ? author.displayName : null,
      text,
      parentUri:
        typeof reply?.parent?.uri === "string" ? reply.parent.uri : null,
      parentCid:
        typeof reply?.parent?.cid === "string" ? reply.parent.cid : null,
      rootUri: typeof reply?.root?.uri === "string" ? reply.root.uri : null,
      rootCid: typeof reply?.root?.cid === "string" ? reply.root.cid : null,
      createdAt: indexedAt,
      isRead: n.isRead === true,
    });
  }
  return out;
}

// Construct a friendly web URL for a Bluesky AT-URI.
// "at://did:plc:abc/app.bsky.feed.post/3kxyz" → "https://bsky.app/profile/<handle>/post/3kxyz"
export function blueskyWebUrl(handle: string, atUri: string): string | null {
  const match = atUri.match(/\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return null;
  return `https://bsky.app/profile/${handle}/post/${match[1]}`;
}

// ─── Bet 4 (comment→DM lead capture) — Direct Messages ───────────────────
//
// Bluesky DMs use the AT-proto chat lexicon (chat.bsky.convo.*), which is NOT
// served by the user's PDS — it's hosted on a separate service reached via the
// `atproto-proxy: did:web:api.bsky.chat#bsky_chat` header on bsky.social. Two
// capability requirements gate it:
//   1. The APP PASSWORD must have been created WITH "Allow access to your direct
//      messages" — a normal app password is rejected by the chat service. There
//      is no token-introspection endpoint, so we DETECT this by attempting a
//      cheap chat call (getConvoForMembers) and treating its access-denied
//      responses as "capability absent".
//   2. The RECIPIENT must allow DMs from the sender (their chat declaration).
//      getConvoForMembers surfaces this too; we map it to scope_missing as well
//      (we can't DM them, period — no point retrying).
//
// On a missing capability we throw DmScopeMissingError so the caller no-ops
// cleanly. We never spam-retry a DM the platform refused.

// The chat service the proxy header routes to. All chat.bsky.convo.* calls go
// to the PDS host but carry this proxy header so it forwards to the chat svc.
const BSKY_CHAT_PROXY = "did:web:api.bsky.chat#bsky_chat";

function chatHeaders(accessJwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessJwt}`,
    "Content-Type": "application/json",
    "atproto-proxy": BSKY_CHAT_PROXY,
  };
}

export interface BlueskyDmCapability {
  granted: boolean;
  reason:
    | "chat_access_denied_app_password"
    | "recipient_not_messageable"
    | "chat_service_unreachable"
    | null;
}

export interface BlueskyDmResult {
  // The conversation id the message was delivered to.
  id: string;
  // The message record id.
  messageId: string;
}

// Resolve a handle (or pass-through a did) to a repo DID via the PDS identity
// resolver. Returns null on failure so callers can no-op rather than throw.
async function resolveActorDid(
  accessJwt: string,
  actor: string,
): Promise<string | null> {
  if (actor.startsWith("did:")) return actor;
  const url = `${SERVICE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(
    actor.replace(/^@/, ""),
  )}`;
  const res = await bskyFetch(url, {
    headers: { Authorization: `Bearer ${accessJwt}` },
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { did?: string };
  return typeof json.did === "string" ? json.did : null;
}

// Probe whether THIS account can open a chat convo with `recipient`. Maps every
// access-denied / unreachable response to a not-granted result (no throw) so
// the caller can record a clean scope_missing. Returns the convoId when the
// convo is reachable so xSendDm-style callers can reuse it.
async function getConvoForMembers(
  accessJwt: string,
  senderDid: string,
  recipientDid: string,
): Promise<{ ok: true; convoId: string } | { ok: false; cap: BlueskyDmCapability }> {
  const url = `${SERVICE}/xrpc/chat.bsky.convo.getConvoForMembers?members=${encodeURIComponent(
    senderDid,
  )}&members=${encodeURIComponent(recipientDid)}`;
  let res: Response;
  try {
    res = await bskyFetch(url, { headers: chatHeaders(accessJwt) });
  } catch {
    return { ok: false, cap: { granted: false, reason: "chat_service_unreachable" } };
  }
  if (res.ok) {
    const json = (await res.json().catch(() => ({}))) as {
      convo?: { id?: string };
    };
    const convoId = json.convo?.id;
    if (convoId) return { ok: true, convoId };
    // 200 but no convo id — treat as unreachable.
    return { ok: false, cap: { granted: false, reason: "chat_service_unreachable" } };
  }
  // Classify the failure. An app password without DM access yields an auth/
  // forbidden error; a recipient who blocks DMs yields a different one. We
  // can't always tell them apart from the status alone, so inspect the body.
  const body = (await res.text().catch(() => "")).toLowerCase();
  if (
    res.status === 401 ||
    res.status === 403 ||
    body.includes("invalidtoken") ||
    body.includes("auth")
  ) {
    return {
      ok: false,
      cap: { granted: false, reason: "chat_access_denied_app_password" },
    };
  }
  return {
    ok: false,
    cap: { granted: false, reason: "recipient_not_messageable" },
  };
}

// Public capability probe used by the cron's static guard. Resolves the
// recipient and checks the chat service can open a convo. Never throws.
export async function blueskyDmCapability(
  creds: BlueskyCredentials,
  recipient: string,
): Promise<BlueskyDmCapability> {
  let session: Session;
  try {
    session = await createSession(creds);
  } catch {
    return { granted: false, reason: "chat_service_unreachable" };
  }
  const recipientDid = await resolveActorDid(session.accessJwt, recipient);
  if (!recipientDid) {
    return { granted: false, reason: "recipient_not_messageable" };
  }
  const probe = await getConvoForMembers(session.accessJwt, session.did, recipientDid);
  return probe.ok ? { granted: true, reason: null } : probe.cap;
}

// Send a DM to `recipient` (handle or did). Opens/loads the convo, then posts
// the message. Throws DmScopeMissingError when the app password lacks chat
// access or the recipient can't be messaged, so the caller no-ops cleanly.
export async function blueskySendDm(
  creds: BlueskyCredentials,
  recipient: string,
  text: string,
): Promise<BlueskyDmResult> {
  if (!recipient) throw new Error("blueskySendDm requires a recipient handle/did.");
  const session = await createSession(creds);
  const recipientDid = await resolveActorDid(session.accessJwt, recipient);
  if (!recipientDid) {
    throw new DmScopeMissingError("bluesky", "chat.bsky", "recipient could not be resolved");
  }
  const convo = await getConvoForMembers(session.accessJwt, session.did, recipientDid);
  if (!convo.ok) {
    throw new DmScopeMissingError(
      "bluesky",
      "chat.bsky",
      convo.cap.reason ?? "chat unavailable",
    );
  }
  const res = await bskyFetch(`${SERVICE}/xrpc/chat.bsky.convo.sendMessage`, {
    method: "POST",
    headers: chatHeaders(session.accessJwt),
    body: JSON.stringify({ convoId: convo.convoId, message: { text } }),
  });
  if (res.status === 401 || res.status === 403) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new DmScopeMissingError("bluesky", "chat.bsky", `${res.status}: ${detail}`);
  }
  if (!res.ok) {
    throw new Error(`Bluesky DM send failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: convo.convoId, messageId: json.id ?? convo.convoId };
}

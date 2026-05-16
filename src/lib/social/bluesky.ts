// Bluesky via AT Protocol. App-password auth (no OAuth app review).
//
// Sessions live ~2 hours; we re-issue on every call to keep it simple.
// Credentials shape: { handle, appPassword }
// Service: https://bsky.social (default PDS — could be parameterized later).

export interface BlueskyCredentials {
  handle: string; // e.g. "marketingmagic.bsky.social"
  appPassword: string;
}

const SERVICE = "https://bsky.social";

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
}

async function createSession(creds: BlueskyCredentials): Promise<Session> {
  const res = await fetch(`${SERVICE}/xrpc/com.atproto.server.createSession`, {
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
    const upRes = await fetch(`${SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
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
  const createRes = await fetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
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

export async function blueskyMetrics(
  creds: BlueskyCredentials,
  postUri: string,
): Promise<BlueskyMetrics> {
  const session = await createSession(creds);
  // getPostThread returns the post with attached counts.
  const res = await fetch(
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

  const res = await fetch(url.toString(), {
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
  const res = await fetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
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
  const res = await fetch(url, {
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

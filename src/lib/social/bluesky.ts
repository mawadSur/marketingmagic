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

// Construct a friendly web URL for a Bluesky AT-URI.
// "at://did:plc:abc/app.bsky.feed.post/3kxyz" → "https://bsky.app/profile/<handle>/post/3kxyz"
export function blueskyWebUrl(handle: string, atUri: string): string | null {
  const match = atUri.match(/\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return null;
  return `https://bsky.app/profile/${handle}/post/${match[1]}`;
}

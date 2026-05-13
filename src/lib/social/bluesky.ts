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

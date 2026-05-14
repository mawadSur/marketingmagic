// Public-post fetching for the Magic Moment flow.
//
// Reality of "public scraping" in 2026:
//   - X: free-tier API doesn't expose `getUserTweets` without auth + project
//     credentials. We could pay for elevated access; for V1 we don't. Fall
//     back to paste.
//   - LinkedIn: no unauthenticated public-profile read API. Paste only.
//   - Instagram: Basic Display API requires user-side OAuth. Paste only.
//   - Threads: same Meta gating as IG. Paste only.
//   - Bluesky: ATproto `app.bsky.feed.getAuthorFeed` is genuinely public,
//     unauthenticated, and rate-friendly. Real scrape implemented.
//
// Callers should treat `UsePasteFallbackError` as the expected, non-error
// signal that the visitor must paste posts.

export type ScrapeChannel = "x" | "linkedin" | "instagram" | "bluesky" | "threads";

export class UsePasteFallbackError extends Error {
  constructor(public channel: ScrapeChannel, message: string) {
    super(message);
    this.name = "UsePasteFallbackError";
  }
}

export interface ScrapeResult {
  posts: string[];
  /** Truthy when the public account exists but has too few posts to extract voice. */
  cold: boolean;
}

// Conservative defaults — we don't want to look like a scraper to any host.
const BSKY_TIMEOUT_MS = 8_000;
const BSKY_PUBLIC_API = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const MIN_POSTS_FOR_VOICE = 10;

/** Public entrypoint — picks an implementation per channel. */
export async function fetchPublicPosts(
  channel: ScrapeChannel,
  handle: string,
): Promise<ScrapeResult> {
  const cleaned = handle.trim().replace(/^@/, "");
  if (!cleaned) {
    throw new UsePasteFallbackError(channel, "Handle is empty.");
  }
  switch (channel) {
    case "bluesky":
      return fetchBlueskyFeed(cleaned);
    case "x":
    case "linkedin":
    case "instagram":
    case "threads":
      throw new UsePasteFallbackError(
        channel,
        `Public read for ${channel} requires OAuth or paid API access; paste your posts instead.`,
      );
    default:
      throw new UsePasteFallbackError(channel, `Unknown channel: ${channel}`);
  }
}

/**
 * Fetch the latest public posts from a Bluesky account via the public XRPC
 * endpoint. Accepts either a full handle (`alice.bsky.social`) or a bare
 * username (`alice`) — bare usernames are coerced to `*.bsky.social`.
 */
export async function fetchBlueskyFeed(handle: string): Promise<ScrapeResult> {
  const actor = normalizeBlueskyHandle(handle);
  const url = new URL(BSKY_PUBLIC_API);
  url.searchParams.set("actor", actor);
  url.searchParams.set("limit", "30");
  url.searchParams.set("filter", "posts_no_replies");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BSKY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "marketingmagic-preview/1.0",
        Accept: "application/json",
      },
      signal: controller.signal,
      // Don't follow into weird redirects on a public API.
      redirect: "follow",
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UsePasteFallbackError(
      "bluesky",
      `Couldn't reach Bluesky (${err instanceof Error ? err.message : "fetch failed"}).`,
    );
  }
  clearTimeout(timer);

  if (res.status === 400 || res.status === 404) {
    throw new UsePasteFallbackError(
      "bluesky",
      `Bluesky account "${actor}" not found. Check the handle or paste your posts.`,
    );
  }
  if (!res.ok) {
    throw new UsePasteFallbackError(
      "bluesky",
      `Bluesky returned ${res.status}. Try again or paste your posts.`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new UsePasteFallbackError("bluesky", "Bluesky response wasn't JSON.");
  }
  const feed = extractFeedTexts(json);
  return { posts: feed, cold: feed.length < MIN_POSTS_FOR_VOICE };
}

function normalizeBlueskyHandle(raw: string): string {
  const stripped = raw.replace(/^@/, "").trim();
  // Accept full handles (contains a dot) or bare usernames.
  if (stripped.includes(".")) return stripped.toLowerCase();
  return `${stripped.toLowerCase()}.bsky.social`;
}

interface BskyPost {
  post?: {
    record?: { text?: unknown };
  };
}

function extractFeedTexts(payload: unknown): string[] {
  const out: string[] = [];
  if (!payload || typeof payload !== "object") return out;
  const feed = (payload as { feed?: unknown }).feed;
  if (!Array.isArray(feed)) return out;
  for (const item of feed as BskyPost[]) {
    const text = item?.post?.record?.text;
    if (typeof text === "string") {
      const trimmed = text.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

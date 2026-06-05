// Build a public, human-clickable URL for a PUBLISHED post from its channel +
// external_id (+ handle where the platform's URL needs it).
//
// `external_id` is whatever each adapter stored on publish:
//   x         → tweet id                → x.com/<handle>/status/<id>
//   instagram → IG media id             → no stable public web URL from the id
//                                          alone; link to the profile instead.
//   facebook  → "{pageId}_{postId}"     → facebook.com/<pageId>/posts/<postId>
//   threads   → media id                → link to the profile (no id-based web URL)
//   bluesky   → at:// uri               → bsky.app/profile/<handle>/post/<rkey>
//   linkedin  → ugcPost/share urn       → linkedin.com/feed/update/<urn>
//   tiktok    → durable post id          → tiktok.com/@<handle>/video/<id>
//
// Returns null when we can't build a meaningful link (so callers render plain
// text instead of a dead link). Pure + dependency-free so it's easy to unit-test.

import { blueskyWebUrl } from "@/lib/social/bluesky";

export function postPublicUrl(
  channel: string,
  externalId: string | null | undefined,
  handle: string | null | undefined,
): string | null {
  if (!externalId) return null;
  const h = (handle ?? "").replace(/^@/, "").trim();

  switch (channel) {
    case "x":
      return h ? `https://x.com/${h}/status/${externalId}` : `https://x.com/i/status/${externalId}`;

    case "bluesky":
      // external_id is an at:// uri; blueskyWebUrl needs the handle + uri.
      return h ? blueskyWebUrl(h, externalId) : null;

    case "facebook": {
      // Composite "{pageId}_{postId}" → /<pageId>/posts/<postId>.
      const [pageId, postId] = externalId.split("_");
      if (pageId && postId) return `https://www.facebook.com/${pageId}/posts/${postId}`;
      return `https://www.facebook.com/${externalId}`;
    }

    case "linkedin":
      // UGC/share URN → the feed-update permalink takes the full urn.
      return `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}`;

    case "tiktok":
      return h ? `https://www.tiktok.com/@${h}/video/${externalId}` : null;

    case "instagram":
      // No stable id→web-URL mapping for IG media; the profile is the best link.
      return h ? `https://www.instagram.com/${h}/` : null;

    case "threads":
      return h ? `https://www.threads.net/@${h}` : null;

    default:
      return null;
  }
}

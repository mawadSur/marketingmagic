// Channel-agnostic dispatcher. Each channel exposes one entry point for
// posting + one for metrics. The cron jobs use this dispatcher so they
// don't need a giant switch per channel.

import type { SupabaseClient } from "@supabase/supabase-js";
import { videoPublishEnabled } from "@/lib/env";
import {
  xPost,
  xUploadMedia,
  xUploadVideo,
  xMetrics,
  loadFreshXCredentials,
  type XCredentials,
} from "./x";
import {
  linkedinPost,
  linkedinUploadImage,
  linkedinUploadVideo,
  linkedinPostVideo,
  linkedinMetrics,
  type LinkedInCredentials,
} from "./linkedin";
import {
  threadsPost,
  threadsPostVideo,
  threadsMetrics,
  type ThreadsCredentials,
} from "./threads";
import {
  instagramPost,
  instagramPostReel,
  instagramMetrics,
  type InstagramCredentials,
} from "./instagram";
import {
  facebookPost,
  facebookPostVideo,
  facebookMetrics,
  type FacebookCredentials,
} from "./facebook";
import {
  blueskyPost,
  blueskyPostVideo,
  blueskyMetrics,
  type BlueskyCredentials,
} from "./bluesky";
import {
  tiktokPostVideo,
  tiktokMetrics,
  loadFreshTikTokCredentials,
  type TikTokCredentials,
} from "./tiktok";
import {
  youtubeUploadVideo,
  youtubeMetrics,
  loadFreshYouTubeCredentials,
  type YouTubeCredentials,
} from "./youtube";

// Media attached to a post. Images come from fal (with a generation prompt
// used as alt text); videos come from the P2 MPT pipeline and live in a
// separate Storage bucket. `prompt` is image-only, hence optional here.
export interface PostMediaItem {
  kind: "image" | "video";
  storage_path: string;
  content_type: string;
  // Image alt text / generation prompt. Absent on video items.
  prompt?: string;
  width?: number;
  height?: number;
}

// Storage bucket per media kind. Images live in `post-media` (003); videos
// land in `post-media-video` (026). loadMedia routes downloads accordingly.
const BUCKET_FOR_KIND: Record<PostMediaItem["kind"], string> = {
  image: "post-media",
  video: "post-media-video",
};

export interface DispatchResult {
  externalId: string;
}

export interface UnifiedMetrics {
  impressions: number;
  likes: number;
  comments: number; // replies for X/Threads/Bluesky, comments for IG/LinkedIn
  shares: number; // reposts/quotes summed where applicable
  clicks: number; // X/LinkedIn only; 0 elsewhere
  saves?: number; // IG only
}

interface MediaBundle {
  kind: PostMediaItem["kind"];
  bytes: Uint8Array;
  contentType: string;
  prompt: string;
  publicUrl: string | null;
  // Carried from the post's media item; videos use these for aspect ratio
  // (Bluesky's video embed wants pixel dimensions). Absent on legacy items.
  width?: number;
  height?: number;
}

async function loadMedia(
  svc: SupabaseClient,
  items: PostMediaItem[],
): Promise<MediaBundle[]> {
  const out: MediaBundle[] = [];
  for (const item of items) {
    // Both images and videos load the same way (download bytes + public URL);
    // only the bucket differs. Unknown kinds are skipped so a future media
    // kind can't crash the publisher.
    const bucket = BUCKET_FOR_KIND[item.kind];
    if (!bucket) continue;
    const { data: blob, error } = await svc.storage.from(bucket).download(item.storage_path);
    if (error || !blob) throw new Error(`media download failed: ${error?.message ?? "no data"}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { data: pub } = svc.storage.from(bucket).getPublicUrl(item.storage_path);
    out.push({
      kind: item.kind,
      bytes,
      contentType: item.content_type,
      prompt: item.prompt ?? "",
      publicUrl: pub.publicUrl,
      width: item.width,
      height: item.height,
    });
  }
  return out;
}

export async function dispatchPost(
  svc: SupabaseClient,
  channel: string,
  credentials: unknown,
  text: string,
  mediaItems: PostMediaItem[],
  socialAccountId: string,
): Promise<DispatchResult> {
  const media = await loadMedia(svc, mediaItems);

  // ─── P3 cross-cutting media rules ──────────────────────────────────────
  // Every channel treats video as the SOLE attachment, so reject a post that
  // mixes an image and a video before we touch any platform API.
  const videos = media.filter((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");
  if (videos.length > 0 && images.length > 0) {
    throw new Error(
      `Cannot post both an image and a video to ${channel} — video must be the only attachment.`,
    );
  }
  const hasVideo = videos.length > 0;
  // Feature-flag gate: code ships for every channel, but only channels in the
  // VIDEO_PUBLISH_CHANNELS allowlist actually publish. Fail clearly otherwise.
  if (hasVideo && !videoPublishEnabled(channel)) {
    throw new Error(`video publishing not yet enabled for ${channel}`);
  }

  switch (channel) {
    case "x": {
      // X OAuth 2.0 access tokens expire in ~2h; refresh proactively before
      // the API calls so a 12h-stale token doesn't fail the post.
      const creds = await loadFreshXCredentials(
        svc,
        socialAccountId,
        credentials as XCredentials,
      );
      const ids: string[] = [];
      if (hasVideo) {
        // Chunked upload (INIT/APPEND/FINALIZE + STATUS poll) → single media id.
        const v = videos[0]!;
        const r = await xUploadVideo(creds, v.bytes, v.contentType);
        ids.push(r.media_id_string);
      } else {
        for (const m of images) {
          const r = await xUploadMedia(creds, m.bytes, m.contentType);
          ids.push(r.media_id_string);
        }
      }
      const sent = await xPost(creds, text, ids.length > 0 ? ids : undefined);
      return { externalId: sent.id };
    }
    case "linkedin": {
      const creds = credentials as LinkedInCredentials;
      if (hasVideo) {
        const v = videos[0]!;
        const videoUrn = await linkedinUploadVideo(creds, v.bytes, v.bytes.byteLength);
        // Use the generation prompt (if any) as the video title; LinkedIn
        // requires a non-empty title on video posts.
        const sent = await linkedinPostVideo(creds, text, videoUrn, v.prompt || "Video");
        return { externalId: sent.id };
      }
      const assetUrns: string[] = [];
      for (const m of images) {
        assetUrns.push(await linkedinUploadImage(creds, m.bytes, m.contentType));
      }
      const sent = await linkedinPost(creds, text, assetUrns);
      return { externalId: sent.id };
    }
    case "threads": {
      const creds = credentials as ThreadsCredentials;
      if (hasVideo) {
        const url = videos[0]?.publicUrl;
        if (!url) throw new Error("Threads video post requires a public video URL.");
        const sent = await threadsPostVideo(creds, text, url);
        return { externalId: sent.id };
      }
      // Threads accepts a public URL for the image, not bytes.
      const imageUrl = images[0]?.publicUrl ?? undefined;
      const sent = await threadsPost(creds, text, imageUrl);
      return { externalId: sent.id };
    }
    case "instagram": {
      const creds = credentials as InstagramCredentials;
      if (hasVideo) {
        const url = videos[0]?.publicUrl;
        if (!url) throw new Error("Instagram video post requires a public video URL.");
        // IG video = Reels only. share_to_feed surfaces it on the main grid too.
        const sent = await instagramPostReel(creds, text, url, { shareToFeed: true });
        return { externalId: sent.id };
      }
      if (images.length === 0 || !images[0]?.publicUrl) {
        throw new Error("Instagram posts require an image.");
      }
      const sent = await instagramPost(creds, text, images[0].publicUrl);
      return { externalId: sent.id };
    }
    case "bluesky": {
      const creds = credentials as BlueskyCredentials;
      if (hasVideo) {
        const v = videos[0]!;
        const sent = await blueskyPostVideo(creds, text, {
          bytes: v.bytes,
          contentType: v.contentType,
          alt: v.prompt,
          aspectRatio:
            v.width && v.height ? { width: v.width, height: v.height } : undefined,
        });
        return { externalId: sent.uri };
      }
      const first = images[0];
      const sent = await blueskyPost(
        creds,
        text,
        first ? { bytes: first.bytes, contentType: first.contentType, alt: first.prompt } : undefined,
      );
      return { externalId: sent.uri };
    }
    case "facebook": {
      // FB Page posts: text + optional link unfurl. Image/video posts go
      // through /{page-id}/photos or /videos — out of scope for v1, callers
      // that pass media items get the link-unfurl path with the public URL.
      const creds = credentials as FacebookCredentials;
      if (hasVideo) {
        const url = videos[0]?.publicUrl;
        if (!url) throw new Error("Facebook video post requires a public video URL.");
        const sent = await facebookPostVideo(creds, text, url);
        return { externalId: sent.id };
      }
      const linkUrl = images[0]?.publicUrl ?? undefined;
      const sent = await facebookPost(creds, text, linkUrl);
      return { externalId: sent.id };
    }
    case "tiktok": {
      // TikTok access tokens expire in 24h; refresh proactively before any API
      // call so a post scheduled a day after connect doesn't 401.
      const creds = await loadFreshTikTokCredentials(
        svc,
        socialAccountId,
        credentials as TikTokCredentials,
      );
      // TikTok is video-only via the Content Posting API — there is no
      // text/image post path. Require a video and run the full
      // creator_info → init → chunked upload → status-poll pipeline.
      if (!hasVideo) {
        throw new Error("TikTok posts require a video.");
      }
      const v = videos[0]!;
      const sent = await tiktokPostVideo(creds, text, v.bytes);
      return { externalId: sent.id };
    }
    case "youtube": {
      // Google access tokens expire in ~1h; refresh proactively before any API
      // call so a post scheduled a day after connect doesn't 401.
      const creds = await loadFreshYouTubeCredentials(
        svc,
        socialAccountId,
        credentials as YouTubeCredentials,
      );
      // YouTube is video-only via the Data API v3 videos.insert path — there is
      // no text/image post. Require a video and run the resumable upload (the
      // post text becomes title + description).
      if (!hasVideo) {
        throw new Error("YouTube posts require a video.");
      }
      const v = videos[0]!;
      const sent = await youtubeUploadVideo(creds, v.bytes, text, v.contentType);
      return { externalId: sent.id };
    }
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }
}

export async function dispatchMetrics(
  svc: SupabaseClient,
  channel: string,
  credentials: unknown,
  externalId: string,
  socialAccountId: string,
): Promise<UnifiedMetrics> {
  switch (channel) {
    case "x": {
      const creds = await loadFreshXCredentials(
        svc,
        socialAccountId,
        credentials as XCredentials,
      );
      const m = await xMetrics(creds, externalId);
      return {
        impressions: m.impressions,
        likes: m.likes,
        comments: m.replies,
        shares: m.reposts,
        clicks: m.clicks,
      };
    }
    case "linkedin": {
      const m = await linkedinMetrics(credentials as LinkedInCredentials, externalId);
      return {
        impressions: m.impressions,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        clicks: m.clicks,
      };
    }
    case "threads": {
      const m = await threadsMetrics(credentials as ThreadsCredentials, externalId);
      return {
        impressions: m.impressions,
        likes: m.likes,
        comments: m.replies,
        shares: m.reposts + m.quotes,
        clicks: 0,
      };
    }
    case "instagram": {
      const m = await instagramMetrics(credentials as InstagramCredentials, externalId);
      return {
        impressions: m.impressions || m.reach,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        clicks: 0,
        saves: m.saved,
      };
    }
    case "bluesky": {
      const m = await blueskyMetrics(credentials as BlueskyCredentials, externalId);
      return {
        impressions: 0,
        likes: m.likes,
        comments: m.replies,
        shares: m.reposts + m.quotes,
        clicks: 0,
      };
    }
    case "facebook": {
      const m = await facebookMetrics(credentials as FacebookCredentials, externalId);
      return {
        impressions: m.impressions || m.reach,
        likes: m.reactions,
        comments: m.comments,
        shares: m.shares,
        clicks: 0,
      };
    }
    case "tiktok": {
      // Stub: tiktokMetrics returns zeros until video insights scopes are
      // wired up. Refresh creds first so a 24h-stale token doesn't 401 once
      // the real implementation lands.
      const creds = await loadFreshTikTokCredentials(
        svc,
        socialAccountId,
        credentials as TikTokCredentials,
      );
      const m = await tiktokMetrics(creds, externalId);
      return {
        impressions: m.impressions,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        clicks: 0,
      };
    }
    case "youtube": {
      // Refresh first so a ~1h-stale token doesn't 401, then read view/like/
      // comment counts via videos.list?part=statistics.
      const creds = await loadFreshYouTubeCredentials(
        svc,
        socialAccountId,
        credentials as YouTubeCredentials,
      );
      const m = await youtubeMetrics(creds, externalId);
      return {
        impressions: m.impressions,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        clicks: 0,
      };
    }
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }
}

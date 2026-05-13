// Channel-agnostic dispatcher. Each channel exposes one entry point for
// posting + one for metrics. The cron jobs use this dispatcher so they
// don't need a giant switch per channel.

import type { SupabaseClient } from "@supabase/supabase-js";
import { xPost, xUploadMedia, xMetrics, type XCredentials } from "./x";
import { linkedinPost, linkedinUploadImage, linkedinMetrics, type LinkedInCredentials } from "./linkedin";
import { threadsPost, threadsMetrics, type ThreadsCredentials } from "./threads";
import { instagramPost, instagramMetrics, type InstagramCredentials } from "./instagram";
import { blueskyPost, blueskyMetrics, type BlueskyCredentials } from "./bluesky";

export interface PostMediaItem {
  kind: "image";
  storage_path: string;
  content_type: string;
  prompt: string;
  width?: number;
  height?: number;
}

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
  bytes: Uint8Array;
  contentType: string;
  prompt: string;
  publicUrl: string | null;
}

async function loadMedia(
  svc: SupabaseClient,
  items: PostMediaItem[],
): Promise<MediaBundle[]> {
  const out: MediaBundle[] = [];
  for (const item of items) {
    if (item.kind !== "image") continue;
    const { data: blob, error } = await svc.storage.from("post-media").download(item.storage_path);
    if (error || !blob) throw new Error(`media download failed: ${error?.message ?? "no data"}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { data: pub } = svc.storage.from("post-media").getPublicUrl(item.storage_path);
    out.push({
      bytes,
      contentType: item.content_type,
      prompt: item.prompt,
      publicUrl: pub.publicUrl,
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
): Promise<DispatchResult> {
  const media = await loadMedia(svc, mediaItems);

  switch (channel) {
    case "x": {
      const creds = credentials as XCredentials;
      const ids: string[] = [];
      for (const m of media) {
        const r = await xUploadMedia(creds, m.bytes, m.contentType);
        ids.push(r.media_id_string);
      }
      const sent = await xPost(creds, text, ids.length > 0 ? ids : undefined);
      return { externalId: sent.id };
    }
    case "linkedin": {
      const creds = credentials as LinkedInCredentials;
      const assetUrns: string[] = [];
      for (const m of media) {
        assetUrns.push(await linkedinUploadImage(creds, m.bytes, m.contentType));
      }
      const sent = await linkedinPost(creds, text, assetUrns);
      return { externalId: sent.id };
    }
    case "threads": {
      const creds = credentials as ThreadsCredentials;
      // Threads accepts a public URL for the image, not bytes.
      const imageUrl = media[0]?.publicUrl ?? undefined;
      const sent = await threadsPost(creds, text, imageUrl);
      return { externalId: sent.id };
    }
    case "instagram": {
      const creds = credentials as InstagramCredentials;
      if (media.length === 0 || !media[0]?.publicUrl) {
        throw new Error("Instagram posts require an image.");
      }
      const sent = await instagramPost(creds, text, media[0].publicUrl);
      return { externalId: sent.id };
    }
    case "bluesky": {
      const creds = credentials as BlueskyCredentials;
      const first = media[0];
      const sent = await blueskyPost(
        creds,
        text,
        first ? { bytes: first.bytes, contentType: first.contentType, alt: first.prompt } : undefined,
      );
      return { externalId: sent.uri };
    }
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }
}

export async function dispatchMetrics(
  channel: string,
  credentials: unknown,
  externalId: string,
): Promise<UnifiedMetrics> {
  switch (channel) {
    case "x": {
      const m = await xMetrics(credentials as XCredentials, externalId);
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
    default:
      throw new Error(`Unsupported channel: ${channel}`);
  }
}

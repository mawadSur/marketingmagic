import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Unit: dispatch video routing (src/lib/social/dispatch.ts) ────────────────
//
// dispatchPost is the channel-agnostic publisher. We mock:
//   - every per-channel adapter module (./x, ./linkedin, ./threads, ./instagram,
//     ./facebook, ./bluesky, ./tiktok) so no real platform API is touched.
//   - `@/lib/env` videoPublishEnabled() so we control the feature-flag gate.
// `loadMedia` is exercised for real, but its only dependency is the injected
// `svc.storage` client, which we fake in-memory.

const videoPublishEnabled = vi.fn<(channel: string) => boolean>();
vi.mock("@/lib/env", () => ({
  videoPublishEnabled: (c: string) => videoPublishEnabled(c),
}));

// Per-channel adapter mocks. Each post/upload fn returns the minimal shape
// dispatch reads (.id / .uri / .media_id_string / a urn string).
const xUploadVideo = vi.fn().mockResolvedValue({ media_id_string: "x-vid-media" });
const xUploadMedia = vi.fn().mockResolvedValue({ media_id_string: "x-img-media" });
const xPost = vi.fn().mockResolvedValue({ id: "x-post-id" });
const loadFreshXCredentials = vi.fn().mockImplementation((_s, _id, creds) => Promise.resolve(creds));
vi.mock("@/lib/social/x", () => ({
  xUploadVideo: (...a: unknown[]) => xUploadVideo(...a),
  xUploadMedia: (...a: unknown[]) => xUploadMedia(...a),
  xPost: (...a: unknown[]) => xPost(...a),
  xMetrics: vi.fn(),
  loadFreshXCredentials: (...a: unknown[]) => loadFreshXCredentials(...a),
}));

const linkedinUploadVideo = vi.fn().mockResolvedValue("urn:li:video:1");
const linkedinPostVideo = vi.fn().mockResolvedValue({ id: "li-vid-post" });
const linkedinUploadImage = vi.fn().mockResolvedValue("urn:li:image:1");
const linkedinPost = vi.fn().mockResolvedValue({ id: "li-img-post" });
vi.mock("@/lib/social/linkedin", () => ({
  linkedinUploadVideo: (...a: unknown[]) => linkedinUploadVideo(...a),
  linkedinPostVideo: (...a: unknown[]) => linkedinPostVideo(...a),
  linkedinUploadImage: (...a: unknown[]) => linkedinUploadImage(...a),
  linkedinPost: (...a: unknown[]) => linkedinPost(...a),
  linkedinMetrics: vi.fn(),
}));

const threadsPostVideo = vi.fn().mockResolvedValue({ id: "th-vid-post" });
const threadsPost = vi.fn().mockResolvedValue({ id: "th-img-post" });
vi.mock("@/lib/social/threads", () => ({
  threadsPostVideo: (...a: unknown[]) => threadsPostVideo(...a),
  threadsPost: (...a: unknown[]) => threadsPost(...a),
  threadsMetrics: vi.fn(),
}));

const instagramPostReel = vi.fn().mockResolvedValue({ id: "ig-reel" });
const instagramPost = vi.fn().mockResolvedValue({ id: "ig-img" });
vi.mock("@/lib/social/instagram", () => ({
  instagramPostReel: (...a: unknown[]) => instagramPostReel(...a),
  instagramPost: (...a: unknown[]) => instagramPost(...a),
  instagramMetrics: vi.fn(),
}));

const facebookPostVideo = vi.fn().mockResolvedValue({ id: "fb-vid" });
const facebookPost = vi.fn().mockResolvedValue({ id: "fb-img" });
vi.mock("@/lib/social/facebook", () => ({
  facebookPostVideo: (...a: unknown[]) => facebookPostVideo(...a),
  facebookPost: (...a: unknown[]) => facebookPost(...a),
  facebookMetrics: vi.fn(),
}));

const blueskyPostVideo = vi.fn().mockResolvedValue({ uri: "at://bsky-vid" });
const blueskyPost = vi.fn().mockResolvedValue({ uri: "at://bsky-img" });
vi.mock("@/lib/social/bluesky", () => ({
  blueskyPostVideo: (...a: unknown[]) => blueskyPostVideo(...a),
  blueskyPost: (...a: unknown[]) => blueskyPost(...a),
  blueskyMetrics: vi.fn(),
}));

const tiktokPostVideo = vi.fn().mockResolvedValue({ id: "tt-vid" });
const loadFreshTikTokCredentials = vi
  .fn()
  .mockImplementation((_s, _id, creds) => Promise.resolve(creds));
vi.mock("@/lib/social/tiktok", () => ({
  tiktokPostVideo: (...a: unknown[]) => tiktokPostVideo(...a),
  tiktokMetrics: vi.fn(),
  loadFreshTikTokCredentials: (...a: unknown[]) => loadFreshTikTokCredentials(...a),
}));

import { dispatchPost, type PostMediaItem } from "@/lib/social/dispatch";

// Fake Supabase storage client. download() returns bytes; getPublicUrl()
// returns a deterministic public URL so the channels that need a URL get one.
function fakeSvc(): SupabaseClient {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const blob = { arrayBuffer: () => Promise.resolve(bytes.buffer) };
  return {
    storage: {
      from(bucket: string) {
        return {
          download: vi.fn().mockResolvedValue({ data: blob, error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.example.com/${bucket}/${path}` },
          }),
        };
      },
    },
  } as unknown as SupabaseClient;
}

const videoItem: PostMediaItem = {
  kind: "video",
  storage_path: "ws/job/final.mp4",
  content_type: "video/mp4",
  width: 1080,
  height: 1920,
};
const imageItem: PostMediaItem = {
  kind: "image",
  storage_path: "ws/img.png",
  content_type: "image/png",
  prompt: "a cat",
};

const ACCOUNT_ID = "acct-1";

beforeEach(() => {
  // Default: every channel is video-enabled unless a test overrides.
  videoPublishEnabled.mockReturnValue(true);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatch: video routing on an ENABLED channel", () => {
  it("routes a video item to the channel's video uploader (bluesky)", async () => {
    const res = await dispatchPost(fakeSvc(), "bluesky", {}, "caption", [videoItem], ACCOUNT_ID);
    expect(blueskyPostVideo).toHaveBeenCalledTimes(1);
    expect(blueskyPost).not.toHaveBeenCalled();
    expect(res.externalId).toBe("at://bsky-vid");
  });

  it("routes a video item to facebookPostVideo with the public URL", async () => {
    const res = await dispatchPost(fakeSvc(), "facebook", {}, "caption", [videoItem], ACCOUNT_ID);
    expect(facebookPostVideo).toHaveBeenCalledTimes(1);
    const [, , url] = facebookPostVideo.mock.calls[0] as [unknown, string, string];
    expect(url).toContain("post-media-video");
    expect(res.externalId).toBe("fb-vid");
  });

  it("routes a video item to threadsPostVideo", async () => {
    await dispatchPost(fakeSvc(), "threads", {}, "caption", [videoItem], ACCOUNT_ID);
    expect(threadsPostVideo).toHaveBeenCalledTimes(1);
    expect(threadsPost).not.toHaveBeenCalled();
  });

  it("routes a video item to the X chunked-video uploader, not the image uploader", async () => {
    await dispatchPost(fakeSvc(), "x", {}, "caption", [videoItem], ACCOUNT_ID);
    expect(xUploadVideo).toHaveBeenCalledTimes(1);
    expect(xUploadMedia).not.toHaveBeenCalled();
    expect(xPost).toHaveBeenCalledTimes(1);
  });

  it("checks the feature flag with the channel id", async () => {
    await dispatchPost(fakeSvc(), "bluesky", {}, "caption", [videoItem], ACCOUNT_ID);
    expect(videoPublishEnabled).toHaveBeenCalledWith("bluesky");
  });
});

describe("dispatch: video gating on a DISABLED channel", () => {
  it('throws "video publishing not yet enabled" and never calls the uploader', async () => {
    videoPublishEnabled.mockReturnValue(false);
    await expect(
      dispatchPost(fakeSvc(), "instagram", {}, "caption", [videoItem], ACCOUNT_ID),
    ).rejects.toThrow(/video publishing not yet enabled for instagram/);
    expect(instagramPostReel).not.toHaveBeenCalled();
  });
});

describe("dispatch: mixed-media rejection", () => {
  it("rejects a post mixing an image and a video before any platform call", async () => {
    await expect(
      dispatchPost(fakeSvc(), "bluesky", {}, "caption", [imageItem, videoItem], ACCOUNT_ID),
    ).rejects.toThrow(/Cannot post both an image and a video/);
    expect(blueskyPostVideo).not.toHaveBeenCalled();
    expect(blueskyPost).not.toHaveBeenCalled();
  });
});

describe("dispatch: image-only still uses the image path", () => {
  it("routes an image-only bluesky post to blueskyPost (not the video uploader)", async () => {
    const res = await dispatchPost(fakeSvc(), "bluesky", {}, "caption", [imageItem], ACCOUNT_ID);
    expect(blueskyPost).toHaveBeenCalledTimes(1);
    expect(blueskyPostVideo).not.toHaveBeenCalled();
    expect(res.externalId).toBe("at://bsky-img");
  });

  it("an image-only post does NOT consult the video feature flag", async () => {
    await dispatchPost(fakeSvc(), "facebook", {}, "caption", [imageItem], ACCOUNT_ID);
    expect(videoPublishEnabled).not.toHaveBeenCalled();
    expect(facebookPost).toHaveBeenCalledTimes(1);
    expect(facebookPostVideo).not.toHaveBeenCalled();
  });

  it("a text-only post (no media) reaches the channel's text path", async () => {
    const res = await dispatchPost(fakeSvc(), "facebook", {}, "just text", [], ACCOUNT_ID);
    expect(facebookPost).toHaveBeenCalledTimes(1);
    expect(res.externalId).toBe("fb-img");
  });
});

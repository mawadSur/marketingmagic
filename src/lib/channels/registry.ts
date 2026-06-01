// Per-channel metadata. Single source of truth for character limits, media
// support, recommended posting windows, and pretty names.
//
// Adding a new channel = add an entry here + a posting adapter under
// src/lib/social/ + an OAuth/settings UI page. Everything else (planner
// prompt, queue UI, char-count validation, metrics dashboard) reads from
// this registry.

export type ChannelId =
  | "x"
  | "linkedin"
  | "threads"
  | "instagram"
  | "bluesky"
  | "facebook"
  | "tiktok";

export interface ChannelSpec {
  id: ChannelId;
  label: string;
  // Max characters for a single post body.
  maxChars: number;
  // Whether the channel supports attaching images.
  supportsImages: boolean;
  // Whether the channel supports videos (future).
  supportsVideo: boolean;
  // Sprout-recommended posting windows by weekday. Times are local to the
  // posting user/audience. Used both as UI hints and as a soft bias for
  // Claude's `suggested_scheduled_at`.
  recommendedWindows: Array<{ weekday: number; ranges: Array<[string, string]> }>;
  // OAuth provider env-key prefix. When the matching keys are unset, the
  // channel is hidden from the "connect" UI.
  oauthEnvPrefix: string | null;
  // Channel-specific posting constraints surfaced to Claude in the planner
  // system prompt.
  promptConstraint: string;
}

// Weekday is 1=Monday … 7=Sunday (ISO).
export const CHANNELS: Record<ChannelId, ChannelSpec> = {
  x: {
    id: "x",
    label: "X",
    maxChars: 280,
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      { weekday: 1, ranges: [["14:00", "15:00"], ["17:00", "17:30"]] },
      { weekday: 2, ranges: [["12:00", "18:00"]] },
      { weekday: 3, ranges: [["12:00", "18:00"]] },
      { weekday: 4, ranges: [["12:00", "18:00"]] },
    ],
    oauthEnvPrefix: "X_",
    promptConstraint:
      "Max 280 characters. Plain prose, no hashtags unless load-bearing, no emojis unless the voice demands them.",
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    maxChars: 3000,
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      { weekday: 1, ranges: [["13:00", "14:00"]] },
      { weekday: 2, ranges: [["11:00", "17:00"]] },
      { weekday: 3, ranges: [["11:00", "16:00"]] },
      { weekday: 4, ranges: [["11:00", "12:00"], ["13:00", "17:00"]] },
      { weekday: 5, ranges: [["11:00", "12:00"], ["13:00", "14:00"]] },
    ],
    oauthEnvPrefix: "LINKEDIN_",
    promptConstraint:
      "Max 3000 characters; aim for 150-400 for readability. Hook in the first line. Professional tone, no emoji unless the brand uses them.",
  },
  threads: {
    id: "threads",
    label: "Threads",
    maxChars: 500,
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      // Sprout doesn't publish Threads-specific data yet; reuse Instagram's
      // proxy windows since that's the closest user base.
      { weekday: 1, ranges: [["14:00", "16:00"]] },
      { weekday: 2, ranges: [["13:00", "19:00"]] },
      { weekday: 3, ranges: [["12:00", "21:00"]] },
      { weekday: 4, ranges: [["12:00", "14:00"]] },
    ],
    oauthEnvPrefix: "META_",
    promptConstraint:
      "Max 500 characters. Conversational, low-stakes. First line is the hook. Threads rewards reply-bait.",
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    maxChars: 2200,
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      { weekday: 1, ranges: [["14:00", "16:00"]] },
      { weekday: 2, ranges: [["13:00", "19:00"]] },
      { weekday: 3, ranges: [["12:00", "21:00"], ["23:00", "23:30"]] },
      { weekday: 4, ranges: [["12:00", "14:00"]] },
    ],
    oauthEnvPrefix: "META_",
    promptConstraint:
      "Max 2200 chars; first 125 chars carry the hook before the 'more' fold. Image-led format — caption supports the image, not the other way around. Hashtags allowed (3-8).",
  },
  bluesky: {
    id: "bluesky",
    label: "Bluesky",
    maxChars: 300,
    supportsImages: true,
    // P3: byte-upload via video.bsky.app. No app-review gate — works as soon
    // as the connected account's email is verified.
    supportsVideo: true,
    recommendedWindows: [
      // No Sprout data; mirror X's pattern given audience overlap.
      { weekday: 1, ranges: [["14:00", "15:00"], ["17:00", "17:30"]] },
      { weekday: 2, ranges: [["12:00", "18:00"]] },
      { weekday: 3, ranges: [["12:00", "18:00"]] },
      { weekday: 4, ranges: [["12:00", "18:00"]] },
    ],
    oauthEnvPrefix: null, // Bluesky uses app passwords, not OAuth
    promptConstraint:
      "Max 300 characters. Same shape as X but the audience is more tech/skeptical. No hashtags.",
  },
  facebook: {
    id: "facebook",
    // Hard limit is 63,206 chars, but Page posts perform best short — the
    // promptConstraint biases Claude to 1-2 tight paragraphs.
    label: "Facebook",
    maxChars: 63206,
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      // Sprout's Facebook Page windows skew weekday mid-morning to mid-
      // afternoon. Monday is a strong slot — kept first/widest.
      { weekday: 1, ranges: [["09:00", "12:00"], ["13:00", "15:00"]] },
      { weekday: 2, ranges: [["09:00", "13:00"]] },
      { weekday: 3, ranges: [["09:00", "15:00"]] },
      { weekday: 4, ranges: [["09:00", "12:00"]] },
      { weekday: 5, ranges: [["09:00", "11:00"]] },
    ],
    oauthEnvPrefix: "META_",
    promptConstraint:
      "Hard cap 63206 chars but write short: 1-2 tight paragraphs, ideally under ~500 chars. Conversational and community-oriented, hook first, one clear CTA. Hashtags sparing (0-2); emoji only if the brand uses them.",
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    // Caption hard cap is 2200 chars (the same as IG). TikTok is video-only —
    // there is no text-only or image-only post via the Content Posting API, so
    // the caption always rides on a video.
    maxChars: 2200,
    // Photo-mode posts exist on TikTok but the v2 publish API this adapter
    // targets is video-first; images are accepted at the registry level so the
    // planner doesn't reject them, but the dispatcher only publishes video.
    supportsImages: true,
    supportsVideo: true,
    recommendedWindows: [
      // No Sprout TikTok dataset; use early-afternoon/evening windows that
      // track TikTok's published "best time to post" guidance (Tue-Thu lean).
      { weekday: 2, ranges: [["14:00", "15:00"], ["18:00", "20:00"]] },
      { weekday: 3, ranges: [["09:00", "11:00"], ["15:00", "17:00"]] },
      { weekday: 4, ranges: [["12:00", "13:00"], ["18:00", "20:00"]] },
      { weekday: 5, ranges: [["14:00", "16:00"]] },
    ],
    oauthEnvPrefix: "TIKTOK_",
    promptConstraint:
      "Max 2200 chars; video-first — the caption supports a vertical short-form video, never stands alone. Hook in the first line, conversational and native to TikTok. Hashtags allowed (3-6); emoji fine if the voice uses them.",
  },
};

export const ENABLED_CHANNELS: ChannelId[] = Object.keys(CHANNELS) as ChannelId[];

export function channelSpec(id: string): ChannelSpec | null {
  return (CHANNELS as Record<string, ChannelSpec | undefined>)[id] ?? null;
}

export function maxCharsFor(id: string): number {
  return channelSpec(id)?.maxChars ?? 280;
}

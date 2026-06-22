// Market a finished user-uploaded clip — turn one rendered clip into queued posts.
//
// SLICE F of the user-video-upload feature. A clip has already been cut from a
// source video (slice C/D produced a `video_jobs` row, kind:"user_clip", that
// reached status 'ready' with its mp4 living in the post-media-video bucket).
// This module takes that finished clip and fans it out into per-channel post
// candidates the user can publish:
//
//   1. Load the finished clip (the ready video_jobs row → storage_path) and the
//      source transcript (caption context — what the clip is actually about).
//   2. Generate a per-channel caption with Claude (one forced tool call, mirrors
//      src/lib/handles/generate.ts — the shared Opus 4.8 client, maxRetries:6,
//      no temperature/top_p). The clip's mp4 is the SOLE media attachment.
//   3. Restrict to channels that (a) the workspace has connected AND (b) are in
//      the VIDEO_PUBLISH_CHANNELS allowlist (others can't actually post video).
//      We surface which were enabled vs skipped so the UI can explain the gap.
//   4. Run the batch through the dedup gate (gateBatchForDedup, failSafe by
//      construction) so a duplicate caption lands pending_approval, never
//      auto-scheduled.
//   5. Insert the posts as pending_approval (NEVER scheduled — a freshly-marketed
//      clip always gets a human glance) so they appear in /queue with the video
//      attached.
//
// No new AI provider, no new bucket, no auto-publish: the clip mp4 is already
// owned in post-media-video and every row is human-gated.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { serverEnv, videoPublishEnabled } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { gateBatchForDedup } from "@/lib/dedup/gate";
import { channelSpec } from "@/lib/channels/registry";
import type { ChannelId } from "@/lib/channels/registry";
import type { Json } from "@/lib/db/types";
import type { PostMediaItem } from "@/lib/social/dispatch";
import type { ClipJobParams, TranscriptSegment, TranscriptSegmentRow } from "./types";

const MODEL = "claude-opus-4-8";

// Minimal builder shape for tables not yet in the generated Database types
// (migration 068's video_transcripts). Lets us read them at the service-role
// boundary until the foundation slice regenerates src/lib/db/types.ts.
type UntypedFrom = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          maybeSingle: () => Promise<{ data: { text: string | null; segments: Json } | null }>;
        };
      };
    };
  };
};

// Cap how much transcript we feed the model as caption context. A clip's worth
// of speech is short; this bounds a pathological full-source transcript so the
// prompt stays cheap and on-topic.
const MAX_CONTEXT_CHARS = 4000;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  // maxRetries=6 matches every other call site — a 429 inside the per-minute
  // input-token window rides out the SDK backoff rather than surfacing raw.
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

// ─────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────
// The caption-generation function shape. Defaults to generateClipCaptions; the
// seam exists so callers/tests can inject a deterministic generator without
// touching the AI client. (ES-module internal references don't route through a
// vi.mock of this same module, so injection is the clean test seam.)
export type CaptionGenerator = (
  channels: ChannelId[],
  transcript: string,
  extra?: string,
) => Promise<Map<ChannelId, string>>;

export interface MarketClipOptions {
  // Channels the caller wants to target. We intersect this with the workspace's
  // connected accounts AND the video-publish allowlist. Omitted → every eligible
  // connected channel.
  channels?: ChannelId[];
  // Extra steer for the caption (e.g. the angle the user typed in the editor).
  captionContext?: string;
  // Test/override seam for caption generation. Defaults to generateClipCaptions.
  generateCaptions?: CaptionGenerator;
}

export interface MarketClipResult {
  ok: boolean;
  // How many post rows were inserted.
  created: number;
  // Channels we actually queued a post for.
  marketed: ChannelId[];
  // Requested/connected channels we skipped because they can't publish video on
  // this deployment (not in VIDEO_PUBLISH_CHANNELS) — surfaced so the UI can say
  // "Bluesky is ready; X needs platform approval before it can post video."
  skippedNotVideoCapable: ChannelId[];
  // Requested channels with no connected account in this workspace.
  skippedNotConnected: ChannelId[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// Caption generation (one forced tool call)
// ─────────────────────────────────────────────────────────────
const captionSchema = z.object({
  captions: z
    .array(
      z.object({
        channel: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .min(1),
});

function buildCaptionTool(channels: ChannelId[]) {
  return {
    name: "submit_captions",
    description:
      "Submit exactly one short, native caption per requested channel for a video clip. " +
      "Write in the platform's voice; no hashtag spam; do not exceed the channel's character limit. " +
      "Call this tool exactly once.",
    input_schema: {
      type: "object",
      required: ["captions"],
      properties: {
        captions: {
          type: "array",
          minItems: channels.length,
          maxItems: channels.length,
          items: {
            type: "object",
            required: ["channel", "text"],
            properties: {
              channel: { type: "string", enum: channels },
              text: { type: "string", minLength: 1, maxLength: 3000 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  } as const;
}

function captionUserPrompt(channels: ChannelId[], transcript: string, extra?: string): string {
  const lines = [
    "Write a caption for a short video clip we are about to publish.",
    "",
    "What the clip is about (its transcript):",
    transcript.trim() ? transcript.trim() : "(no transcript available — write a tight, curiosity-driven caption from the angle below)",
  ];
  if (extra && extra.trim()) {
    lines.push("", `Angle the user wants: ${extra.trim()}`);
  }
  lines.push(
    "",
    `Produce one caption for each of these channels: ${channels.join(", ")}.`,
    "Match each platform's voice and character budget. Return via submit_captions.",
  );
  return lines.join("\n");
}

const CAPTION_SYSTEM =
  "You are a social media copywriter. You write concise, native, hook-first captions for short " +
  "video clips. You never invent facts not supported by the transcript, never use more than two " +
  "hashtags, and you respect each platform's tone (punchy for X/Bluesky, slightly fuller for " +
  "Facebook/Threads/LinkedIn).";

// Generate one caption per channel. Exported so the action layer (and tests) can
// stub it independently of the gate/insert plumbing.
export async function generateClipCaptions(
  channels: ChannelId[],
  transcript: string,
  extra?: string,
): Promise<Map<ChannelId, string>> {
  if (channels.length === 0) return new Map();
  const tool = buildCaptionTool(channels);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: "text", text: CAPTION_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_captions" },
    messages: [{ role: "user", content: captionUserPrompt(channels, transcript, extra) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "submit_captions") {
    throw new Error("Claude did not call submit_captions.");
  }
  const parsed = captionSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `Clip captions validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const byChannel = new Map<ChannelId, string>();
  for (const c of parsed.data.captions) {
    if (channels.includes(c.channel as ChannelId)) {
      byChannel.set(c.channel as ChannelId, c.text);
    }
  }
  return byChannel;
}

// ─────────────────────────────────────────────────────────────
// Transcript context loader
// ─────────────────────────────────────────────────────────────
function segmentsToText(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(" ");
}

// Best-effort: load the source transcript text for a clip's parent upload. Falls
// back to whatever `text` is on the transcript row, else the joined segments,
// else "" — never throws; a missing transcript just means a thinner prompt.
async function loadTranscriptContext(
  svc: ReturnType<typeof supabaseService>,
  workspaceId: string,
  uploadedVideoId: string,
): Promise<string> {
  // `video_transcripts` ships in migration 068; the generated Database types are
  // regenerated by the foundation slice, so cast at this boundary until they
  // land (mirrors how slice-A reads its new uploaded_videos table).
  const { data } = await (svc as unknown as UntypedFrom)
    .from("video_transcripts")
    .select("text, segments")
    .eq("workspace_id", workspaceId)
    .eq("uploaded_video_id", uploadedVideoId)
    .maybeSingle();
  if (!data) return "";

  const row = data;
  let text = (row.text ?? "").trim();
  if (!text && Array.isArray(row.segments)) {
    const segs = (row.segments as unknown as TranscriptSegmentRow[]).map((s) => ({
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.text,
    }));
    text = segmentsToText(segs).trim();
  }
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
}

// ─────────────────────────────────────────────────────────────
// Channel eligibility
// ─────────────────────────────────────────────────────────────
interface ConnectedAccount {
  id: string;
  channel: ChannelId;
}

// Resolve which requested channels we can actually market on, and why the rest
// were dropped. A channel is eligible iff it has a connected account in the
// workspace AND it's in the VIDEO_PUBLISH_CHANNELS allowlist.
function resolveEligibility(
  requested: ChannelId[] | undefined,
  connected: ConnectedAccount[],
): {
  eligible: ConnectedAccount[];
  notConnected: ChannelId[];
  notVideoCapable: ChannelId[];
} {
  const byChannel = new Map<ChannelId, ConnectedAccount>();
  for (const a of connected) if (!byChannel.has(a.channel)) byChannel.set(a.channel, a);

  // Default target = every connected channel.
  const targets = requested && requested.length > 0 ? requested : [...byChannel.keys()];

  const eligible: ConnectedAccount[] = [];
  const notConnected: ChannelId[] = [];
  const notVideoCapable: ChannelId[] = [];

  for (const ch of targets) {
    const acct = byChannel.get(ch);
    if (!acct) {
      notConnected.push(ch);
      continue;
    }
    if (!videoPublishEnabled(ch)) {
      notVideoCapable.push(ch);
      continue;
    }
    eligible.push(acct);
  }
  return { eligible, notConnected, notVideoCapable };
}

// ─────────────────────────────────────────────────────────────
// marketClip
// ─────────────────────────────────────────────────────────────
/**
 * Turn a finished clip into per-channel pending_approval posts in /queue.
 *
 * @param workspaceId  owning workspace (every read/insert is scoped to it)
 * @param jobId        the ready `video_jobs` row (kind:"user_clip") for the clip
 */
export async function marketClip(
  workspaceId: string,
  jobId: string,
  opts: MarketClipOptions = {},
): Promise<MarketClipResult> {
  const svc = supabaseService();

  // 1. Load the finished clip job. Must be this workspace's, ready, with an mp4.
  const { data: jobRow } = await svc
    .from("video_jobs")
    .select("id, workspace_id, status, storage_path, params")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!jobRow) return emptyResult("Clip not found.");
  const job = jobRow as {
    id: string;
    workspace_id: string;
    status: string;
    storage_path: string | null;
    params: Json;
  };
  if (job.status !== "ready" || !job.storage_path) {
    return emptyResult("Clip isn't finished rendering yet.");
  }

  const params = (job.params ?? {}) as Partial<ClipJobParams>;
  const uploadedVideoId = typeof params.uploadedVideoId === "string" ? params.uploadedVideoId : null;

  // 2. Which channels can we market on?
  const { data: accountRows } = await svc
    .from("social_accounts")
    .select("id, channel, status")
    .eq("workspace_id", workspaceId);
  const connected: ConnectedAccount[] = ((accountRows ?? []) as { id: string; channel: string; status: string | null }[])
    .filter((a) => a.status == null || a.status === "connected")
    .map((a) => ({ id: a.id, channel: a.channel as ChannelId }));

  const { eligible, notConnected, notVideoCapable } = resolveEligibility(opts.channels, connected);
  if (eligible.length === 0) {
    return {
      ok: false,
      created: 0,
      marketed: [],
      skippedNotVideoCapable: notVideoCapable,
      skippedNotConnected: notConnected,
      error:
        notVideoCapable.length > 0
          ? "None of the selected channels can publish video on this plan yet."
          : "Connect a video-capable channel first.",
    };
  }

  // 3. Caption context + generation.
  const transcript = uploadedVideoId
    ? await loadTranscriptContext(svc, workspaceId, uploadedVideoId)
    : "";
  const eligibleChannels = eligible.map((a) => a.channel);
  const generate = opts.generateCaptions ?? generateClipCaptions;
  const captions = await generate(eligibleChannels, transcript, opts.captionContext);

  // 4. Build one post candidate per eligible channel that got a caption.
  const mediaItem: PostMediaItem = {
    kind: "video",
    storage_path: job.storage_path,
    content_type: "video/mp4",
  };

  const candidates = eligible.flatMap((acct) => {
    const raw = captions.get(acct.channel);
    if (!raw || !raw.trim()) return [];
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
    return [
      {
        workspace_id: workspaceId,
        social_account_id: acct.id,
        channel: acct.channel as ChannelId,
        text,
        // NEVER scheduled: a freshly-marketed clip always gets a human glance.
        status: "pending_approval" as const,
        media: [mediaItem] as unknown as Json,
        generation_metadata: {
          origin: "clip_marketing",
          clip_job_id: job.id,
          ...(uploadedVideoId ? { uploaded_video_id: uploadedVideoId } : {}),
        } satisfies Record<string, Json>,
      },
    ];
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      created: 0,
      marketed: [],
      skippedNotVideoCapable: notVideoCapable,
      skippedNotConnected: notConnected,
      error: "Couldn't generate a caption for any selected channel.",
    };
  }

  // 5. Dedup gate (failSafe by construction) → a dup lands pending_approval (it
  //    already is) + low_confidence + content_hash stamped on every row. Then
  //    insert. The gate never auto-schedules; our rows are pending_approval, so
  //    a marketed clip can't bypass review.
  const gated = await gateBatchForDedup(workspaceId, candidates);
  const { error } = await svc.from("posts").insert(gated as unknown as never);
  if (error) {
    return {
      ok: false,
      created: 0,
      marketed: [],
      skippedNotVideoCapable: notVideoCapable,
      skippedNotConnected: notConnected,
      error: error.message,
    };
  }

  return {
    ok: true,
    created: gated.length,
    marketed: gated.map((g) => g.channel as ChannelId),
    skippedNotVideoCapable: notVideoCapable,
    skippedNotConnected: notConnected,
  };
}

function emptyResult(error: string): MarketClipResult {
  return {
    ok: false,
    created: 0,
    marketed: [],
    skippedNotVideoCapable: [],
    skippedNotConnected: [],
    error,
  };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { userVideoUploadEnabled } from "@/lib/env";
import { ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { marketClip, type MarketClipResult } from "@/lib/video/uploads/market-clip";

// Server action behind the editor's "Market this clip" control (slice E links
// here). Resolves the active workspace from the session (so a caller can only
// market their OWN clips), validates input at the boundary, then delegates to
// marketClip — which generates per-channel captions, gates the batch for dedup,
// and inserts pending_approval posts that surface in /queue with the video
// attached. Never auto-schedules.

const channelEnum = z.enum(ENABLED_CHANNELS as [ChannelId, ...ChannelId[]]);

const schema = z.object({
  jobId: z.string().uuid(),
  // Optional explicit channel subset; omitted → every eligible connected channel.
  channels: z.array(channelEnum).optional(),
  captionContext: z.string().max(500).optional(),
});

export type MarketClipActionResult = MarketClipResult;

export async function marketClipAction(input: {
  jobId: string;
  channels?: ChannelId[];
  captionContext?: string;
}): Promise<MarketClipActionResult> {
  if (!userVideoUploadEnabled()) {
    return {
      ok: false,
      created: 0,
      marketed: [],
      skippedNotVideoCapable: [],
      skippedNotConnected: [],
      error: "Video upload isn't enabled on this workspace.",
    };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      created: 0,
      marketed: [],
      skippedNotVideoCapable: [],
      skippedNotConnected: [],
      error: parsed.error.issues[0]?.message ?? "Invalid request.",
    };
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const result = await marketClip(ws.id, parsed.data.jobId, {
    channels: parsed.data.channels,
    captionContext: parsed.data.captionContext,
  });

  if (result.ok) {
    // The new posts land in the queue's approval list.
    revalidatePath("/queue");
    revalidatePath(`/video/upload/${parsed.data.jobId}`);
  }
  return result;
}

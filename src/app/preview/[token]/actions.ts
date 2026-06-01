"use server";

import { verifyPreviewToken } from "@/lib/preview/token";
import { createPreviewShare } from "@/lib/growth/preview-share";
import { track, hashHandle } from "@/lib/preview/analytics";

export type ShareActionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// "Share this plan" — turn the in-URL signed preview token into a PERSISTED,
// short, social-unfurl-friendly link. We re-verify the token server-side (so a
// tampered/expired token can't mint a share), snapshot ONLY its preview content
// into preview_shares, and hand back the /p/<slug> path. The full token is
// never exposed in the shared URL — the slug is an opaque capability and the
// stored payload carries no account data.
export async function createShareFromTokenAction(token: string): Promise<ShareActionResult> {
  const result = verifyPreviewToken(token);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "expired"
          ? "This preview expired — generate a fresh one to share it."
          : "This preview link looks broken; generate a new one to share.",
    };
  }
  const { payload } = result;

  try {
    const slug = await createPreviewShare({
      channel: payload.channel,
      handle: payload.handle,
      niche_hint: payload.niche_hint,
      plan: payload.plan,
      voice_summary: payload.voice_summary,
      source: payload.source,
    });
    track({
      stage: "preview_shared",
      channel: payload.channel,
      handle_hash: hashHandle(payload.handle),
      meta: { posts: payload.plan.posts.length },
    });
    return { ok: true, path: `/p/${slug}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not create a share link.",
    };
  }
}

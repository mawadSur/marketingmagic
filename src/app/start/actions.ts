"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { fetchPublicPosts, UsePasteFallbackError } from "@/lib/preview/scrape";
import { previewPlan } from "@/lib/preview/plan";
import { signPreviewToken } from "@/lib/preview/token";
import { recordAttempt, clientIpFromHeaders } from "@/lib/preview/rate-limit";
import { track, hashHandle } from "@/lib/preview/analytics";
import { checkRateLimit } from "@/lib/rate-limit";

export type StartActionState = {
  error: string | null;
  /** Truthy when the visitor MUST paste to continue (handle not scrape-able
   *  or scrape returned too few posts). The UI re-renders with the paste
   *  textarea revealed. */
  needsPaste: boolean;
};

const MIN_POSTS_FOR_VOICE = 10;
const MIN_NICHE_LEN = 0;
const MAX_PASTE_POSTS = 30;

const HANDLE_RE = /^[A-Za-z0-9._-]{1,80}$/;

const channelEnum = z.enum(["x", "linkedin", "instagram", "bluesky", "threads"]);

const formSchema = z.object({
  channel: channelEnum,
  handle: z
    .string()
    .trim()
    .min(1, "Handle is required.")
    .max(80, "Handle is too long.")
    .transform((s) => s.replace(/^@/, ""))
    .refine((s) => HANDLE_RE.test(s) || /^[A-Za-z0-9._-]+\.[A-Za-z]{2,}$/.test(s), {
      message: "Handle should be letters, numbers, dots, dashes, or underscores.",
    }),
  niche_hint: z.string().trim().max(280).optional(),
  pasted_posts: z.string().max(20_000).optional(),
});

function parsePastedPosts(raw: string | undefined): string[] {
  if (!raw) return [];
  // Accept either blank-line-separated or single-line-per-post. We split on
  // double newlines first; if that yields only 1 entry, fall back to
  // single-newline splitting.
  const doubleSplit = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (doubleSplit.length > 1) return doubleSplit.slice(0, MAX_PASTE_POSTS);
  return raw
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PASTE_POSTS);
}

export async function startPreviewAction(
  _prev: StartActionState,
  formData: FormData,
): Promise<StartActionState> {
  const parsed = formSchema.safeParse({
    channel: formData.get("channel"),
    handle: formData.get("handle"),
    niche_hint: formData.get("niche_hint") ?? undefined,
    pasted_posts: formData.get("pasted_posts") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      needsPaste: false,
    };
  }
  const { channel, handle, niche_hint } = parsed.data;
  const pastedPosts = parsePastedPosts(parsed.data.pasted_posts);

  // Defence in depth: only honour channels enabled in the registry.
  if (!ENABLED_CHANNELS.includes(channel as ChannelId)) {
    return { error: "Channel is not supported.", needsPaste: false };
  }

  // Rate limit per IP. Even on Vercel cold-start nodes this catches the
  // common script-kiddie attempt to spam handles from one box. This is the
  // in-memory limiter (5/hour per IP).
  const hdrs = await headers();
  const ip = clientIpFromHeaders(hdrs);
  const limit = recordAttempt(ip);
  if (!limit.ok) {
    track({
      stage: "preview_rate_limited",
      channel,
      handle_hash: hashHandle(handle),
      meta: { reset_minutes: Math.ceil(limit.resetMs / 60_000) },
    });
    const minutes = Math.max(1, Math.ceil(limit.resetMs / 60_000));
    return {
      error: `You've hit the preview limit (5/hour). Try again in ~${minutes} minute${minutes === 1 ? "" : "s"} — or sign up to generate plans without limits.`,
      needsPaste: false,
    };
  }

  // Additional distributed rate limit (Upstash) for the AI-spend path, keyed by
  // IP (10 req / min). When Upstash is unconfigured, this is a no-op (allows all).
  const distributedLimit = await checkRateLimit("start-preview", ip, 10, 60_000);
  if (!distributedLimit.ok) {
    const minutes = Math.max(1, Math.ceil(distributedLimit.resetMs / 60_000));
    return {
      error: `Too many preview requests. Try again in ~${minutes} minute${minutes === 1 ? "" : "s"}.`,
      needsPaste: false,
    };
  }

  track({
    stage: "landing_submit",
    channel,
    handle_hash: hashHandle(handle),
    meta: { has_paste: pastedPosts.length > 0, niche_len: niche_hint?.length ?? 0 },
  });

  // 1. Source the posts. Paste wins if present (visitor opted in).
  let posts: string[] = [];
  let source: "scrape" | "paste" = "paste";
  if (pastedPosts.length > 0) {
    posts = pastedPosts;
    source = "paste";
  } else {
    try {
      const result = await fetchPublicPosts(channel, handle);
      posts = result.posts;
      source = "scrape";
      track({
        stage: "scrape_success",
        channel,
        handle_hash: hashHandle(handle),
        meta: { count: posts.length, cold: result.cold },
      });
      if (result.cold) {
        track({
          stage: "preview_cold_profile",
          channel,
          handle_hash: hashHandle(handle),
          meta: { count: posts.length },
        });
        return {
          error: `We found only ${posts.length} posts for @${handle} — not enough to capture your voice. Paste 5–10 of your favorites below and we'll generate the preview from those.`,
          needsPaste: true,
        };
      }
    } catch (err) {
      if (err instanceof UsePasteFallbackError) {
        track({
          stage: "scrape_fallback",
          channel,
          handle_hash: hashHandle(handle),
          meta: { reason: err.message.slice(0, 120) },
        });
        return { error: err.message, needsPaste: true };
      }
      return {
        error: err instanceof Error ? err.message : "Something went wrong fetching your posts.",
        needsPaste: true,
      };
    }
  }

  if (posts.length < MIN_POSTS_FOR_VOICE && source === "paste") {
    // Paste was attempted but too thin. Re-prompt with the textarea open.
    return {
      error: `Paste at least ${MIN_POSTS_FOR_VOICE} of your posts (one per line, or separated by blank lines) so we can capture your voice. You gave us ${posts.length}.`,
      needsPaste: true,
    };
  }

  if (niche_hint && niche_hint.length < MIN_NICHE_LEN) {
    return { error: "Niche description is too short.", needsPaste: false };
  }

  // 2. Generate the preview plan.
  let preview;
  try {
    preview = await previewPlan({
      channel: channel as ChannelId,
      handle,
      posts,
      niche_hint,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "We couldn't generate your preview. Try again.",
      needsPaste: false,
    };
  }

  // 3. Sign the token. State lives in the URL — no DB write.
  const token = signPreviewToken({
    channel,
    handle,
    niche_hint: niche_hint || undefined,
    plan: preview.plan,
    voice_summary: preview.voice_summary,
    source,
  });

  track({
    stage: "preview_generated",
    channel,
    handle_hash: hashHandle(handle),
    meta: {
      posts_in: posts.length,
      posts_out: preview.plan.posts.length,
      source,
    },
  });

  // Tokens are typically 2-4 KB. Path-segment encoding is fine since the
  // characters are all `[A-Za-z0-9._-]` by construction.
  redirect(`/preview/${token}`);
}

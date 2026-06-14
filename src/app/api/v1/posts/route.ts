import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withApiKey } from "@/lib/api/middleware";
import { validationError } from "@/lib/api/errors";
import { ENABLED_CHANNELS, maxCharsFor } from "@/lib/channels/registry";

// /api/v1/posts
//   GET  — list posts (scope posts:read), optional ?status= &limit= &offset=
//   POST — schedule a post (scope posts:write). Writes status='scheduled'; the
//          existing post-scheduled cron publishes it (reuses retry+idempotency).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const mediaItem = z.object({
  kind: z.enum(["image", "video"]),
  storage_path: z.string().min(1),
  content_type: z.string().min(1),
  prompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const createBody = z.object({
  channel: z.enum(ENABLED_CHANNELS as [string, ...string[]]),
  text: z.string().min(1).max(3000),
  social_account_id: z.string().uuid().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  theme: z.string().max(60).nullable().optional(),
  media: z.array(mediaItem).max(4).optional(),
});

export const GET = withApiKey("posts:read")(async (req: NextRequest, { api, requestId }) => {
  const parsed = listQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw validationError("Invalid query parameters.", parsed.error.issues);
  const posts = await api.listPosts(parsed.data);
  return NextResponse.json({ data: posts, request_id: requestId });
});

export const POST = withApiKey("posts:write")(async (req: NextRequest, { api, requestId }) => {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw validationError("Request body must be valid JSON.");
  }
  const parsed = createBody.safeParse(json);
  if (!parsed.success) throw validationError("Invalid post body.", parsed.error.issues);
  const body = parsed.data;

  // Per-channel character cap (the Zod 3000 ceiling is the global max; each
  // channel is tighter). Reject loudly rather than letting the platform truncate.
  const cap = maxCharsFor(body.channel);
  if (body.text.length > cap) {
    throw validationError(
      `Text exceeds the ${body.channel} limit of ${cap} characters (got ${body.text.length}).`,
    );
  }

  const post = await api.createPost({
    channel: body.channel,
    text: body.text,
    socialAccountId: body.social_account_id,
    scheduledAt: body.scheduled_at ?? null,
    theme: body.theme ?? null,
    media: body.media ?? [],
  });
  return NextResponse.json({ data: post, request_id: requestId }, { status: 201 });
});

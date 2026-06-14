import { NextResponse } from "next/server";
import { z } from "zod";
import { withApiKey } from "@/lib/api/middleware";
import { validationError } from "@/lib/api/errors";

// /api/v1/posts/:id
//   GET    — fetch one post (scope posts:read). 404 if not in this workspace.
//   DELETE — cancel a scheduled post (scope posts:write). Archives it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idParam = z.string().uuid();

export const GET = withApiKey("posts:read")(async (_req, { api, requestId, params }) => {
  const parsed = idParam.safeParse(params.id);
  if (!parsed.success) throw validationError("Post id must be a UUID.");
  const post = await api.getPost(parsed.data);
  return NextResponse.json({ data: post, request_id: requestId });
});

export const DELETE = withApiKey("posts:write")(async (_req, { api, requestId, params }) => {
  const parsed = idParam.safeParse(params.id);
  if (!parsed.success) throw validationError("Post id must be a UUID.");
  const cancelled = await api.cancelPost(parsed.data);
  if (!cancelled) {
    // getPost inside cancelPost already 404s for cross-workspace ids; reaching
    // here means it exists but is already posted/failed/archived.
    throw validationError("Post is not in a cancellable state (already posted, failed, or archived).");
  }
  return NextResponse.json({ data: { id: parsed.data, status: "archived" }, request_id: requestId });
});

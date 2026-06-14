import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/api/middleware";

// GET /api/v1/channels — list the workspace's connected channels (credentials
// redacted; data comes from the social_accounts_safe view). Scope: channels:read.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiKey("channels:read")(async (_req, { api, requestId }) => {
  const channels = await api.listChannels();
  return NextResponse.json({ data: channels, request_id: requestId });
});

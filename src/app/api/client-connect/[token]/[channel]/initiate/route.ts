import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/env";
import { resolveSelfConnectToken } from "@/lib/client-connect/token";
import { isSelfConnectChannel, startSelfConnect } from "@/lib/client-connect/initiate";

// POST /api/client-connect/[token]/[channel]/initiate
//
// The tokenized, UNAUTHENTICATED entry point for a client self-connect. The
// agency emails the client a /connect/[token] link; the landing page POSTs here
// to start the OAuth dialog for the chosen channel. We:
//   1. Resolve the token → workspaceId (the entire trust boundary; validates
//      revoked / expired via the hardened service-role resolver).
//   2. Validate the channel is one the self-connect flow supports (Meta family).
//   3. Hand off to startSelfConnect, which reuses the EXISTING per-channel
//      OAuth authorize builders + state/cookie shape so the unmodified callback
//      attributes the connected account to the client's workspace.
//
// POST-only (matches the authed initiate routes) so a prefetch / stray GET can
// never kick off a token-allocation round-trip.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string; channel: string }> },
) {
  const { token, channel } = await params;
  const base = siteUrl();

  // Resolve the token first — an invalid/revoked/expired link must never reach
  // a provider. Bounce to the landing page, which renders the generic invalid
  // state (we don't leak which condition failed).
  const ctx = await resolveSelfConnectToken(token);
  if (!ctx) {
    return NextResponse.redirect(new URL("/connect/invalid", base), 303);
  }

  if (!isSelfConnectChannel(channel)) {
    return NextResponse.redirect(
      `${base}/connect/${encodeURIComponent(token)}?error=unsupported_channel`,
      303,
    );
  }

  const { redirect } = startSelfConnect({
    channel,
    workspaceId: ctx.workspaceId,
    rawToken: token,
  });
  return redirect;
}

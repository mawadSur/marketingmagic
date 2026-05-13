import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { linkedinExchangeCode, linkedinVerify, type LinkedInCredentials } from "@/lib/social/linkedin";

// LinkedIn OAuth callback. State is `<workspaceId>:<nonce>` — nonce is
// stored in a short-lived cookie set when starting the flow.
export async function GET(req: NextRequest) {
  const env = serverEnv();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL(`/settings/channels?error=${encodeURIComponent(error)}`, env.NEXT_PUBLIC_SITE_URL),
    );
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }
  const [workspaceId, nonce] = state.split(":");
  if (!workspaceId || !nonce) {
    return NextResponse.json({ error: "bad state" }, { status: 400 });
  }
  const cookieNonce = req.cookies.get("li_oauth_nonce")?.value;
  if (cookieNonce !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }

  const redirectUri = `${env.NEXT_PUBLIC_SITE_URL}/api/oauth/linkedin/callback`;
  try {
    const token = await linkedinExchangeCode({ code, redirectUri });
    const profile = await linkedinVerify(token.access_token);
    const creds: LinkedInCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      memberUrn: profile.urn,
    };
    const svc = supabaseService();
    const { error: dbErr } = await svc.from("social_accounts").upsert(
      {
        workspace_id: workspaceId,
        channel: "linkedin",
        handle: profile.name,
        credentials: creds as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
    if (dbErr) {
      return NextResponse.redirect(
        new URL(`/settings/channels?error=${encodeURIComponent(dbErr.message)}`, env.NEXT_PUBLIC_SITE_URL),
      );
    }
    const res = NextResponse.redirect(new URL("/settings/channels?connected=linkedin", env.NEXT_PUBLIC_SITE_URL));
    res.cookies.delete("li_oauth_nonce");
    return res;
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/settings/channels?error=${encodeURIComponent(err instanceof Error ? err.message : "oauth_failed")}`,
        env.NEXT_PUBLIC_SITE_URL,
      ),
    );
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  instagramExchangeCode,
  instagramVerify,
  type InstagramCredentials,
} from "@/lib/social/instagram";

export async function GET(req: NextRequest) {
  const env = serverEnv();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/settings/channels?error=${encodeURIComponent(error)}`, env.NEXT_PUBLIC_SITE_URL));
  }
  if (!code || !state) return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  const [workspaceId, nonce] = state.split(":");
  if (!workspaceId || !nonce) return NextResponse.json({ error: "bad state" }, { status: 400 });
  if (req.cookies.get("ig_oauth_nonce")?.value !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }

  const redirectUri = `${env.NEXT_PUBLIC_SITE_URL}/api/oauth/instagram/callback`;
  try {
    const token = await instagramExchangeCode({ code, redirectUri });
    const profile = await instagramVerify(token.accessToken, token.igUserId);
    const creds: InstagramCredentials = {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      igUserId: token.igUserId,
    };
    const svc = supabaseService();
    const { error: dbErr } = await svc.from("social_accounts").upsert(
      {
        workspace_id: workspaceId,
        channel: "instagram",
        handle: profile.username,
        credentials: creds as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
    if (dbErr) {
      return NextResponse.redirect(new URL(`/settings/channels?error=${encodeURIComponent(dbErr.message)}`, env.NEXT_PUBLIC_SITE_URL));
    }
    const res = NextResponse.redirect(new URL("/settings/channels?connected=instagram", env.NEXT_PUBLIC_SITE_URL));
    res.cookies.delete("ig_oauth_nonce");
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

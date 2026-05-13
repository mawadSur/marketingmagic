import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { threadsExchangeCode, threadsVerify, type ThreadsCredentials } from "@/lib/social/threads";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/settings/channels?error=${encodeURIComponent(error)}`, base));
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }
  const [workspaceId, nonce] = state.split(":");
  if (!workspaceId || !nonce) return NextResponse.json({ error: "bad state" }, { status: 400 });
  if (req.cookies.get("th_oauth_nonce")?.value !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }

  const redirectUri = `${base}/api/oauth/threads/callback`;
  try {
    const token = await threadsExchangeCode({ code, redirectUri });
    const profile = await threadsVerify(token.accessToken, token.userId);
    const creds: ThreadsCredentials = {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      userId: token.userId,
    };

    // Plan-gating: hobby caps channels at 1; reconnect of the same handle
    // is grandfathered through.
    try {
      await assertWithinChannelQuota(workspaceId, { channel: "threads", handle: profile.username });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return NextResponse.redirect(
          new URL(`/settings/billing?error=${encodeURIComponent(err.message)}`, base),
        );
      }
      throw err;
    }

    const svc = supabaseService();
    const { error: dbErr } = await svc.from("social_accounts").upsert(
      {
        workspace_id: workspaceId,
        channel: "threads",
        handle: profile.username,
        credentials: creds as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
    if (dbErr) {
      return NextResponse.redirect(new URL(`/settings/channels?error=${encodeURIComponent(dbErr.message)}`, base));
    }
    const res = NextResponse.redirect(new URL("/settings/channels?connected=threads", base));
    res.cookies.delete("th_oauth_nonce");
    return res;
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/settings/channels?error=${encodeURIComponent(err instanceof Error ? err.message : "oauth_failed")}`,
        base,
      ),
    );
  }
}

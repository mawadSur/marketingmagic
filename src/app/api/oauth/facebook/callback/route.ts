import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  facebookExchangeCode,
  facebookVerify,
  type FacebookCredentials,
} from "@/lib/social/facebook";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// Facebook redirects here with ?code=... & state=... after the user
// approves on facebook.com. We verify the CSRF nonce, exchange the code
// for a long-lived Page access token, persist to social_accounts, and
// land the user on /settings/channels with a green banner.

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const errorDescription = req.nextUrl.searchParams.get("error_description");
  if (error) {
    const msg = errorDescription || error;
    return NextResponse.redirect(
      new URL(`/settings/channels?error=${encodeURIComponent(msg)}`, base),
    );
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }
  const [workspaceId, nonce] = state.split(":");
  if (!workspaceId || !nonce) {
    return NextResponse.json({ error: "bad state" }, { status: 400 });
  }
  if (req.cookies.get("fb_oauth_nonce")?.value !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }

  const redirectUri = `${base}/api/oauth/facebook/callback`;
  try {
    const exchanged = await facebookExchangeCode({ code, redirectUri });
    // Sanity-check the Page token works against the Page node.
    const { name } = await facebookVerify(exchanged.pageId, exchanged.pageAccessToken);

    const creds: FacebookCredentials = {
      pageId: exchanged.pageId,
      pageAccessToken: exchanged.pageAccessToken,
      expiresAt: exchanged.expiresAt,
    };

    // Plan-gating: hobby tier caps connected channels at 1.
    try {
      await assertWithinChannelQuota(workspaceId, { channel: "facebook", handle: name });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const r = NextResponse.redirect(
          new URL(`/settings/billing?error=${encodeURIComponent(err.message)}`, base),
        );
        r.cookies.delete("fb_oauth_nonce");
        return r;
      }
      throw err;
    }

    const svc = supabaseService();
    const { error: dbErr } = await svc.from("social_accounts").upsert(
      {
        workspace_id: workspaceId,
        channel: "facebook",
        handle: name,
        credentials: creds as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
    if (dbErr) {
      return NextResponse.redirect(
        new URL(`/settings/channels?error=${encodeURIComponent(dbErr.message)}`, base),
      );
    }
    const res = NextResponse.redirect(new URL("/settings/channels?connected=facebook", base));
    res.cookies.delete("fb_oauth_nonce");
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

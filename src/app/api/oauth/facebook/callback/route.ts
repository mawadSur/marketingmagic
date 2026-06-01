import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  facebookExchangeCode,
  facebookVerify,
  FB_PAGE_PICKER_COOKIE,
  type FacebookCredentials,
  type FacebookPickerStash,
} from "@/lib/social/facebook";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// Facebook redirects here with ?code=... & state=... after the user
// approves on facebook.com. We verify the CSRF nonce and exchange the code
// for the list of publishable Pages the operator manages.
//
// Page picker: when exactly one Page is publishable we finalize it straight
// to social_accounts (no extra click — old behavior). When the operator
// manages more than one Page, we can't know which one maps to the current
// (client) workspace, so we stash every candidate Page + Page token in a
// short-lived httpOnly cookie (mirrors the nonce cookie — server-only, never
// in a URL, never persisted to the DB) and bounce them to
// /settings/channels/facebook/select-target to choose. The pick action there
// resolves the chosen Page's token from the cookie and inserts a single
// `connected` social_accounts row. We deliberately do NOT persist a
// placeholder row: social_accounts.status has no "pending" value, and a
// half-connected row would show as postable in the channels list.

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  // FB sends OAuth errors in two shapes depending on the dialog product:
  //   - OAuth 2.0 spec:  ?error=&error_description=
  //   - FB legacy/Comet: ?error_code=&error_message=
  // Handle both — otherwise the real reason gets swallowed and the user
  // sees "missing code/state" instead of the actual FB error string.
  const error =
    req.nextUrl.searchParams.get("error") ||
    req.nextUrl.searchParams.get("error_code");
  const errorDescription =
    req.nextUrl.searchParams.get("error_description") ||
    req.nextUrl.searchParams.get("error_message");
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
    const svc = supabaseService();

    // ── Multi-Page: stash candidates in a cookie and route to the picker ──
    // We don't know which Page maps to this client workspace. Stash every
    // candidate Page + Page token in a short-lived httpOnly cookie (no DB row,
    // no Page token in a URL) and let the operator pick. The quota check runs
    // in the pick action, where the single finalized row is actually inserted.
    if (exchanged.pages.length > 1) {
      const stash: FacebookPickerStash = {
        workspaceId,
        expiresAt: exchanged.expiresAt,
        pages: exchanged.pages,
      };
      const res = NextResponse.redirect(
        new URL("/settings/channels/facebook/select-target", base),
      );
      res.cookies.delete("fb_oauth_nonce");
      res.cookies.set(FB_PAGE_PICKER_COOKIE, JSON.stringify(stash), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60,
        path: "/",
      });
      return res;
    }

    // ── Single Page: finalize immediately (old behavior) ──────────────────
    const only = exchanged.pages[0]!;
    // Sanity-check the Page token works against the Page node.
    const { name } = await facebookVerify(only.pageId, only.pageAccessToken);

    const creds: FacebookCredentials = {
      pageId: only.pageId,
      pageAccessToken: only.pageAccessToken,
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

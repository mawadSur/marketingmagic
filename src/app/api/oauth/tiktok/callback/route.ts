import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  tiktokExchangeCode,
  tiktokVerify,
  type TikTokCredentials,
} from "@/lib/social/tiktok";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// TikTok redirects here with ?code=...&state=... once the user approves on
// www.tiktok.com/v2/auth/authorize/. We:
//   1. Pull the {codeVerifier, state, workspaceId} stash out of the cookie.
//   2. Verify the state query matches the stashed state (CSRF binding).
//   3. Exchange code + verifier for tokens at open.tiktokapis.com/v2/oauth/token/.
//   4. Resolve the handle via user.info.basic, then upsert into social_accounts.
//
// Auth required — supabaseServer().auth.getUser() must succeed before we touch
// workspace data. Persistence uses the service role because credentials must
// never round-trip through anon-key clients.

interface StashedState {
  v: string; // code_verifier
  s: string; // state
  w: string; // workspace id
}

function decodeState(raw: string): StashedState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "v" in parsed &&
      "s" in parsed &&
      "w" in parsed &&
      typeof (parsed as Record<string, unknown>).v === "string" &&
      typeof (parsed as Record<string, unknown>).s === "string" &&
      typeof (parsed as Record<string, unknown>).w === "string"
    ) {
      return parsed as StashedState;
    }
    return null;
  } catch {
    return null;
  }
}

function redirectWithError(base: string, message: string): NextResponse {
  const res = NextResponse.redirect(
    new URL(`/settings/channels/tiktok?error=${encodeURIComponent(message)}`, base),
  );
  res.cookies.delete({ name: "tiktok_oauth_state", path: "/api/oauth/tiktok" });
  return res;
}

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const env = serverEnv();

  // User may have hit "Cancel" on TikTok's consent screen — TikTok sends
  // ?error=access_denied (and an error_description).
  const oauthErr = req.nextUrl.searchParams.get("error");
  if (oauthErr) {
    const desc = req.nextUrl.searchParams.get("error_description") ?? oauthErr;
    return redirectWithError(base, desc);
  }

  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state");
  if (!code || !stateParam) {
    return redirectWithError(base, "missing_oauth_params");
  }

  const cookieValue = req.cookies.get("tiktok_oauth_state")?.value;
  if (!cookieValue) {
    return redirectWithError(base, "tiktok_state_expired");
  }
  const stash = decodeState(cookieValue);
  if (!stash) {
    return redirectWithError(base, "tiktok_state_invalid");
  }
  if (stash.s !== stateParam) {
    return redirectWithError(base, "tiktok_state_mismatch");
  }

  // Require an authenticated session before persisting credentials. Anyone who
  // reaches this callback with a forged cookie still can't write to
  // social_accounts without proving they own the workspace.
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", base));
  }

  // Confirm the authed user actually has access to the stashed workspace
  // (defense in depth — the workspace id came from our own cookie, but we
  // don't trust cookies for authorization).
  const { data: workspace } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", stash.w)
    .maybeSingle();
  if (!workspace) {
    return redirectWithError(base, "workspace_access_denied");
  }

  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return redirectWithError(base, "tiktok_not_configured");
  }

  // redirect_uri must EXACTLY match the value sent to /authorize.
  const redirectUri = `${base}/api/oauth/tiktok/callback`;

  // Step 3: exchange code + verifier for access + refresh tokens.
  let tokens: Awaited<ReturnType<typeof tiktokExchangeCode>>;
  try {
    tokens = await tiktokExchangeCode({
      clientKey: env.TIKTOK_CLIENT_KEY,
      clientSecret: env.TIKTOK_CLIENT_SECRET,
      code,
      codeVerifier: stash.v,
      redirectUri,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tiktok_token_exchange_failed";
    return redirectWithError(base, msg);
  }

  // TikTok always returns a refresh_token (the access token lives only 24h, so
  // without it the connection would die in a day with no way to recover). Fail
  // loudly if it's somehow missing so the operator notices.
  if (!tokens.refresh_token) {
    return redirectWithError(
      base,
      "TikTok did not return a refresh_token — confirm the video.publish scope is granted on your TikTok app.",
    );
  }

  const creds: TikTokCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  // Resolve the canonical handle via user.info.basic. Also sanity-checks the
  // token works before we persist it.
  let handle: string;
  try {
    const verified = await tiktokVerify(creds);
    handle = verified.handle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tiktok_verify_failed";
    return redirectWithError(base, msg);
  }

  // Plan gating — same shape as the other OAuth callbacks.
  try {
    await assertWithinChannelQuota(stash.w, { channel: "tiktok", handle });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      const r = NextResponse.redirect(
        new URL(`/settings/billing?error=${encodeURIComponent(err.message)}`, base),
      );
      r.cookies.delete({ name: "tiktok_oauth_state", path: "/api/oauth/tiktok" });
      return r;
    }
    throw err;
  }

  const svc = supabaseService();
  const { error: dbErr } = await svc.from("social_accounts").upsert(
    {
      workspace_id: stash.w,
      channel: "tiktok",
      handle,
      // Cast through Record<string, string> to satisfy the jsonb column type —
      // supabase-js's generated Json type rejects literal credential shapes;
      // we know this jsonb stores the TikTokCredentials structure.
      credentials: creds as unknown as Record<string, string>,
      status: "connected",
    },
    { onConflict: "workspace_id,channel,handle" },
  );
  if (dbErr) {
    return redirectWithError(base, dbErr.message);
  }

  const res = NextResponse.redirect(
    new URL(`/settings/channels/tiktok?connected=${encodeURIComponent(handle)}`, base),
  );
  res.cookies.delete({ name: "tiktok_oauth_state", path: "/api/oauth/tiktok" });
  return res;
}

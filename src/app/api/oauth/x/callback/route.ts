import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { xExchangeCode, xVerify, type XCredentials } from "@/lib/social/x";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// X redirects here with ?code=...&state=... once the user approves on
// twitter.com/i/oauth2/authorize. We:
//   1. Pull the {codeVerifier, state, workspaceId} stash out of the cookie.
//   2. Verify the state query matches the stashed state (CSRF binding).
//   3. Exchange code + verifier for access_token + refresh_token at
//      /2/oauth2/token (PKCE).
//   4. Verify the token via /2/users/me, then upsert into social_accounts.
//
// Auth required — supabaseServer().auth.getUser() must succeed before we
// touch workspace data. Persistence uses service role because credentials
// must never round-trip through anon-key clients.

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
    new URL(`/settings/channels/x?error=${encodeURIComponent(message)}`, base),
  );
  res.cookies.delete({ name: "x_oauth_state", path: "/api/oauth/x" });
  return res;
}

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const env = serverEnv();

  // User may have hit "Cancel" on X's screen — X sends ?error=access_denied.
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

  const cookieValue = req.cookies.get("x_oauth_state")?.value;
  if (!cookieValue) {
    return redirectWithError(base, "x_state_expired");
  }
  const stash = decodeState(cookieValue);
  if (!stash) {
    return redirectWithError(base, "x_state_invalid");
  }
  if (stash.s !== stateParam) {
    return redirectWithError(base, "x_state_mismatch");
  }

  // Require an authenticated session before persisting credentials. Anyone
  // who can reach this callback URL with a forged cookie still can't write
  // to social_accounts without proving they own the workspace.
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", base));
  }

  // Confirm the authed user actually has access to the workspace stashed in
  // state (defense in depth — the workspace id came from our own cookie, but
  // we don't trust cookies for authorization).
  const { data: workspace } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", stash.w)
    .maybeSingle();
  if (!workspace) {
    return redirectWithError(base, "workspace_access_denied");
  }

  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    return redirectWithError(base, "x_not_configured");
  }

  const redirectUri = `${base}/api/oauth/x/callback`;

  // Step 3: exchange code + verifier for access + refresh tokens.
  let tokens: Awaited<ReturnType<typeof xExchangeCode>>;
  try {
    tokens = await xExchangeCode({
      clientId: env.X_CLIENT_ID,
      clientSecret: env.X_CLIENT_SECRET,
      code,
      codeVerifier: stash.v,
      redirectUri,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "x_token_exchange_failed";
    return redirectWithError(base, msg);
  }

  // X must issue a refresh_token because we requested the offline.access
  // scope. If it didn't, the connection would die in 2h with no way to
  // recover — fail loudly so the operator notices.
  if (!tokens.refresh_token) {
    return redirectWithError(
      base,
      "X did not return a refresh_token — confirm the 'offline.access' scope is enabled in your X app's User Authentication Settings.",
    );
  }

  const creds: XCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  // Sanity-check the token works against /2/users/me. Also resolves the
  // canonical username for storage.
  let username: string;
  try {
    const verified = await xVerify(creds);
    username = verified.username;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "x_verify_failed";
    return redirectWithError(base, msg);
  }

  // Plan gating — same shape as before.
  try {
    await assertWithinChannelQuota(stash.w, { channel: "x", handle: username });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      const r = NextResponse.redirect(
        new URL(`/settings/billing?error=${encodeURIComponent(err.message)}`, base),
      );
      r.cookies.delete({ name: "x_oauth_state", path: "/api/oauth/x" });
      return r;
    }
    throw err;
  }

  const svc = supabaseService();
  const { error: dbErr } = await svc.from("social_accounts").upsert(
    {
      workspace_id: stash.w,
      channel: "x",
      handle: username,
      // Cast through Record<string, string> to satisfy the jsonb column type
      // — supabase-js's generated Json type rejects literal credential
      // shapes; we know this jsonb stores the XCredentials structure.
      credentials: creds as unknown as Record<string, string>,
      status: "connected",
    },
    { onConflict: "workspace_id,channel,handle" },
  );
  if (dbErr) {
    return redirectWithError(base, dbErr.message);
  }

  const res = NextResponse.redirect(
    new URL(`/settings/channels/x?connected=${encodeURIComponent(username)}`, base),
  );
  res.cookies.delete({ name: "x_oauth_state", path: "/api/oauth/x" });
  return res;
}

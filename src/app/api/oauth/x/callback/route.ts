import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { xExchangeCode, xVerify, type XCredentials } from "@/lib/social/x";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";
import { verifyOAuthState } from "@/lib/social/oauth-state";

// X redirects here with ?code=...&state=... once the user approves on
// twitter.com/i/oauth2/authorize. We:
//   1. Verify the SIGNED state param (mobile-robust CSRF — survives cookie drops).
//   2. Pull the {codeVerifier, workspaceId} stash out of the cookie (PKCE requires it).
//   3. Exchange code + verifier for access_token + refresh_token at /2/oauth2/token (PKCE).
//   4. Verify the token via /2/users/me, then upsert into social_accounts.
//
// Auth required — supabaseServer().auth.getUser() must succeed before we
// touch workspace data. Persistence uses service role because credentials
// must never round-trip through anon-key clients.
//
// PKCE note: the cookie is still REQUIRED for the code_verifier (PKCE spec).
// The signed state makes CSRF mobile-robust, but if the cookie is missing the
// token exchange will fail — this is a PKCE limitation. The verifier is a
// cryptographic secret (not a CSRF token).

interface StashedState {
  v: string; // code_verifier
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
      "w" in parsed &&
      typeof (parsed as Record<string, unknown>).v === "string" &&
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

  // CSRF: verify the SIGNED state (mobile-robust — survives cookie drops).
  const verified = verifyOAuthState(stateParam);
  if (!verified.ok) {
    return redirectWithError(base, `oauth_state_${verified.reason}`);
  }
  const workspaceId = verified.workspaceId;

  // PKCE: pull the code_verifier from the cookie. Unlike the CSRF state, the
  // verifier MUST come from a cookie because PKCE requires it server-side for
  // the token exchange. If the cookie is missing, the flow fails — this is a
  // PKCE limitation (the verifier is a cryptographic secret, not a CSRF token).
  const cookieValue = req.cookies.get("x_oauth_state")?.value;
  if (!cookieValue) {
    return redirectWithError(base, "x_state_expired");
  }
  const stash = decodeState(cookieValue);
  if (!stash) {
    return redirectWithError(base, "x_state_invalid");
  }
  // Sanity-check: the workspaceId in the cookie should match the signed state.
  // Both were set by our /initiate, but defense-in-depth in case of cookie
  // replay or tampering.
  if (stash.w !== workspaceId) {
    return redirectWithError(base, "x_workspace_mismatch");
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

  // Confirm the authed user actually has access to the workspace from the signed
  // state (defense in depth — the signed state proves it came from our /initiate,
  // but we still verify the user owns the workspace before persisting tokens).
  const { data: workspace } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
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
    await assertWithinChannelQuota(workspaceId, { channel: "x", handle: username });
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
      workspace_id: workspaceId,
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

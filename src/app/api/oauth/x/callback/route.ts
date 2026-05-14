import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  xAccessToken,
  xVerify,
  type XConnectionMethod,
  type XCredentials,
} from "@/lib/social/x";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// Twitter redirects here with ?oauth_token=...&oauth_verifier=... once the
// user approves on Twitter's side. We:
//   1. Pull the request-token secret out of the stashed httpOnly cookie.
//   2. Verify the oauth_token query matches the cookie (CSRF binding).
//   3. Exchange verifier for the permanent user token via /oauth/access_token.
//   4. Verify the token via /2/users/me, then upsert into social_accounts.
//
// Auth is required — we use supabaseServer().auth.getUser() to confirm a
// session before touching workspace data. Persistence uses the service role
// because credentials must never round-trip through anon-key clients.

interface StashedState {
  t: string; // request token
  s: string; // request token secret
  w: string; // workspace id
}

function decodeState(raw: string): StashedState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "t" in parsed &&
      "s" in parsed &&
      "w" in parsed &&
      typeof (parsed as Record<string, unknown>).t === "string" &&
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
  // Clean up the state cookie on error too so a retry starts fresh.
  res.cookies.delete({ name: "x_oauth_state", path: "/api/oauth/x" });
  return res;
}

export async function GET(req: NextRequest) {
  const base = siteUrl();
  const env = serverEnv();

  // User may have hit "Cancel" on Twitter's screen — short-circuit.
  const denied = req.nextUrl.searchParams.get("denied");
  if (denied) {
    return redirectWithError(base, "x_authorization_denied");
  }

  const oauthToken = req.nextUrl.searchParams.get("oauth_token");
  const verifier = req.nextUrl.searchParams.get("oauth_verifier");
  if (!oauthToken || !verifier) {
    return redirectWithError(base, "missing_oauth_params");
  }

  // Pull stashed state. If the cookie is missing the flow probably timed out
  // (>10 min) or the user came in from another origin.
  const cookieValue = req.cookies.get("x_oauth_state")?.value;
  if (!cookieValue) {
    return redirectWithError(base, "x_state_expired");
  }
  const stash = decodeState(cookieValue);
  if (!stash) {
    return redirectWithError(base, "x_state_invalid");
  }
  if (stash.t !== oauthToken) {
    // CSRF binding failed — the request token Twitter returned doesn't match
    // what we issued. Refuse to proceed.
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

  // Step 4: exchange verifier for the permanent user-context token.
  let access: Awaited<ReturnType<typeof xAccessToken>>;
  try {
    access = await xAccessToken({
      apiKey: env.X_CLIENT_ID,
      apiSecret: env.X_CLIENT_SECRET,
      requestToken: stash.t,
      requestTokenSecret: stash.s,
      verifier,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "x_access_token_failed";
    return redirectWithError(base, msg);
  }

  const creds: XCredentials = {
    apiKey: env.X_CLIENT_ID,
    apiSecret: env.X_CLIENT_SECRET,
    accessToken: access.oauth_token,
    accessTokenSecret: access.oauth_token_secret,
  };

  // Sanity-check the token actually works against /2/users/me. This also
  // resolves the canonical username (Twitter's screen_name field can drift
  // from the user's display handle if they renamed recently).
  let username: string;
  try {
    const verified = await xVerify(creds);
    username = verified.username;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "x_verify_failed";
    return redirectWithError(base, msg);
  }

  // Plan gating — same shape as the manual-paste action.
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

  // Tag the credentials JSONB with the connection method so the UI can
  // tell OAuth-issued tokens apart from manual-paste ones. The dispatcher
  // casts to XCredentials and reads only the four token fields — extra keys
  // are ignored.
  const persisted: XCredentials & { connection_method: XConnectionMethod } = {
    ...creds,
    connection_method: "oauth",
  };

  const svc = supabaseService();
  const { error: dbErr } = await svc.from("social_accounts").upsert(
    {
      workspace_id: stash.w,
      channel: "x",
      handle: username,
      // Cast through Record<string, unknown> to satisfy the Json column type
      // without leaking the literal credential shape into the DB types.
      credentials: persisted as unknown as Record<string, string>,
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

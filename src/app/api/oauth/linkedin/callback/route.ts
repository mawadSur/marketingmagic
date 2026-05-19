import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  linkedinExchangeCode,
  linkedinVerify,
  linkedinListOrganizations,
  hasOrgPostScope,
  type LinkedInCredentials,
} from "@/lib/social/linkedin";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// LinkedIn OAuth callback. State is `<workspaceId>:<nonce>` — nonce is
// stored in a short-lived cookie set when starting the flow.
export async function GET(req: NextRequest) {
  const base = siteUrl();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL(`/settings/channels?error=${encodeURIComponent(error)}`, base),
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

  // Require an authenticated session before persisting credentials. The nonce
  // cookie proves the redirect originated from our /initiate, but doesn't
  // prove the user holding the session still owns the target workspace.
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", base));
  }

  // Confirm the authed user has access to the workspace named in state.
  // RLS on workspaces enforces is_workspace_member — a non-member sees no row.
  const { data: workspace } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.redirect(
      new URL(`/settings/channels?error=${encodeURIComponent("workspace_access_denied")}`, base),
    );
  }

  const redirectUri = `${base}/api/oauth/linkedin/callback`;
  try {
    const token = await linkedinExchangeCode({ code, redirectUri });
    const profile = await linkedinVerify(token.access_token);
    const creds: LinkedInCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      memberUrn: profile.urn,
      grantedScopes: token.scope,
    };

    // Community Management API: when w_organization_social was actually
    // granted (LinkedIn approval through), fetch the orgs the user
    // admins so we can offer the org picker. When the scope isn't
    // granted (review pending), short-circuit to [] and fall through to
    // personal-profile only.
    const orgs = hasOrgPostScope(creds)
      ? await linkedinListOrganizations(token.access_token)
      : [];

    // Plan-gating: hobby caps channels at 1; reconnect of an existing
    // (channel, handle) is grandfathered through.
    try {
      await assertWithinChannelQuota(workspaceId, { channel: "linkedin", handle: profile.name });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return NextResponse.redirect(
          new URL(
            `/settings/billing?error=${encodeURIComponent(err.message)}`,
            base,
          ),
        );
      }
      throw err;
    }

    const svc = supabaseService();
    const { data: inserted, error: dbErr } = await svc
      .from("social_accounts")
      .upsert(
        {
          workspace_id: workspaceId,
          channel: "linkedin",
          handle: profile.name,
          credentials: creds as unknown as Record<string, string>,
          status: "connected",
        },
        { onConflict: "workspace_id,channel,handle" },
      )
      .select("id")
      .single();
    if (dbErr || !inserted) {
      return NextResponse.redirect(
        new URL(
          `/settings/channels?error=${encodeURIComponent(dbErr?.message ?? "db_insert_failed")}`,
          base,
        ),
      );
    }

    // If the user admins at least one Company Page AND we got the scope,
    // route them to the org picker so they can choose personal vs. org
    // for this connection. Otherwise it's personal-only.
    if (orgs.length > 0) {
      const orgsParam = encodeURIComponent(JSON.stringify(orgs));
      const res = NextResponse.redirect(
        new URL(
          `/settings/channels/linkedin/select-target?account=${inserted.id}&orgs=${orgsParam}`,
          base,
        ),
      );
      res.cookies.delete("li_oauth_nonce");
      return res;
    }

    const res = NextResponse.redirect(new URL("/settings/channels?connected=linkedin", base));
    res.cookies.delete("li_oauth_nonce");
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

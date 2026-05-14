import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { exchangeOAuthCode } from "@/lib/integrations/discord";

// Discord bot install callback. State is `<workspaceId>:<nonce>`; nonce is
// matched against the short-lived cookie set by /install. The cookie nonce
// proves "this redirect originated from our /install", and the Supabase
// session proves "this user owns the workspace".
//
// On success we DON'T have a target_channel_id yet — Discord install flow
// only gives us the guild id, not a specific channel. We persist a sentinel
// channel id of "" and let the user pick a channel from
// /integrations/discord. We still record the row so the UI can show "bot
// installed, awaiting channel selection".
//
// To avoid clobbering an already-chosen channel during a reinstall, we
// upsert on (workspace_id, provider, target_channel_id) only when the row
// doesn't already exist for this guild. We achieve that by querying first.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const env = serverEnv();
  const base = siteUrl();

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/integrations/discord?error=${encodeURIComponent(error)}`, base),
      303,
    );
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }

  const [workspaceId, nonce] = state.split(":");
  if (!workspaceId || !nonce) {
    return NextResponse.json({ error: "bad state" }, { status: 400 });
  }

  const cookieNonce = req.cookies.get("discord_oauth_nonce")?.value;
  if (!cookieNonce || cookieNonce !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }

  // Require the same authed user that initiated the flow. RLS on workspaces
  // enforces is_workspace_member — a non-member sees no row, which we treat
  // as "access denied".
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", base), 303);
  }
  const { data: workspace } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.redirect(
      new URL("/integrations/discord?error=workspace_access_denied", base),
      303,
    );
  }

  // Configuration sanity — handled separately from "no error" because we
  // want the redirect target to communicate the failure mode.
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/integrations/discord?error=not_configured", base),
      303,
    );
  }

  let token: Awaited<ReturnType<typeof exchangeOAuthCode>>;
  try {
    token = await exchangeOAuthCode({
      code,
      redirectUri: `${base}/api/integrations/discord/callback`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "oauth_exchange_failed";
    return NextResponse.redirect(
      new URL(`/integrations/discord?error=${encodeURIComponent(msg)}`, base),
      303,
    );
  }

  const guildId = token.guild?.id ?? null;
  const guildName = token.guild?.name ?? null;
  // NEVER persist the user access_token here — the bot does NOT use it; we
  // talk to channels via the bot token. Stash only the install metadata.
  const authPayload = {
    scope: token.scope,
    guild_name: guildName,
    installed_user_id: user.id,
  };

  // We don't have a channel yet. To avoid violating the unique constraint
  // (workspace, provider, target_channel_id), use a guild-scoped sentinel
  // — guildId itself with a prefix — so a second install to a different
  // server doesn't collide. The UI immediately walks the user through
  // picking a real channel which then upserts the canonical row.
  const sentinelChannelId = `__pending__:${guildId ?? "no-guild"}`;

  const svc = supabaseService();
  // Check whether this workspace already has a row for this guild (any
  // channel). If so, leave the existing channel alone — the operator
  // probably just re-clicked install to refresh auth. If the OAuth response
  // didn't include guild info we just skip the lookup and insert a fresh
  // row; this happens when scope=bot wasn't granted by the user.
  const lookup = svc
    .from("integrations")
    .select("id, target_channel_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "discord");
  const { data: existing } = guildId
    ? await lookup.eq("target_guild_id", guildId).maybeSingle()
    : { data: null };

  if (existing) {
    await svc
      .from("integrations")
      .update({ auth_payload: authPayload })
      .eq("id", existing.id);
  } else {
    const { error: insErr } = await svc.from("integrations").insert({
      workspace_id: workspaceId,
      provider: "discord",
      target_channel_id: sentinelChannelId,
      target_guild_id: guildId,
      auth_payload: authPayload,
      installed_by: user.id,
    });
    if (insErr) {
      return NextResponse.redirect(
        new URL(`/integrations/discord?error=${encodeURIComponent(insErr.message)}`, base),
        303,
      );
    }
  }

  const res = NextResponse.redirect(
    new URL(`/integrations/discord?installed=1&guild=${encodeURIComponent(guildName ?? "")}`, base),
    303,
  );
  res.cookies.delete("discord_oauth_nonce");
  return res;
}

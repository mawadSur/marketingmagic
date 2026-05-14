import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";

// Kick off Discord bot install. Symmetric with /settings/channels/linkedin
// (server-action -> redirect): we mint a nonce, stash it in a short-lived
// cookie, and bounce the user to discord.com/oauth2/authorize. The callback
// at /api/integrations/discord/callback verifies the nonce matches.
//
// Scopes:
//   - bot                  : install the bot user into the chosen guild
//   - applications.commands: register slash commands in that guild
// Permissions integer: 274877910016
//   = SEND_MESSAGES (2048) + EMBED_LINKS (16384) + READ_MESSAGE_HISTORY (65536)
//     + USE_APPLICATION_COMMANDS (2147483648). We deliberately ask for the
//     minimum surface area; everything else is denied by default.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bit math kept as a constant — easier to audit than the raw integer.
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const USE_APP_COMMANDS = 1n << 31n;
const BOT_PERMISSIONS = (
  SEND_MESSAGES |
  EMBED_LINKS |
  READ_MESSAGE_HISTORY |
  USE_APP_COMMANDS
).toString();

export async function GET(_req: NextRequest) {
  const env = serverEnv();
  const base = siteUrl();
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/integrations/discord?error=not_configured", base),
      303,
    );
  }

  // Require an authed session — the OAuth redirect carries the workspace id
  // in `state`, but the cookie nonce + Supabase session combo is what binds
  // the install back to a real user.
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", base), 303);
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
  const redirectUri = `${base}/api/integrations/discord/callback`;

  const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", "bot applications.commands");
  authorizeUrl.searchParams.set("permissions", BOT_PERMISSIONS);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  const jar = await cookies();
  jar.set("discord_oauth_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });

  return NextResponse.redirect(authorizeUrl.toString(), 303);
}

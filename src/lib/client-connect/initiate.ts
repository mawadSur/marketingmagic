// ─────────────────────────────────────────────────────────────
// Client self-connect — OAuth initiate (Agency Proof Engine, migration 044)
// ─────────────────────────────────────────────────────────────
//
// REUSE, DO NOT REBUILD. This module starts the EXACT same OAuth handshake the
// authenticated per-channel initiate routes start (src/app/api/oauth/<ch>/
// initiate) — it calls the SAME *AuthorizeUrl() builders and produces the SAME
// `state = "<workspaceId>:<nonce>"` + same `<prefix>_oauth_nonce` cookie shape.
// The ONLY difference is where the workspace comes from: instead of
// getActiveWorkspaceOrRedirect() (authed operator + active-workspace cookie), it
// comes from a validated SelfConnectContext.workspaceId (the client's tokenized
// link). Because the resulting state + cookie are byte-for-byte what the
// EXISTING callbacks already parse, the unmodified callbacks attribute the
// connected account to the correct client workspace. Zero callback changes.
//
// SCOPE — Meta family only (Facebook, Instagram, Threads). Those three
// callbacks resolve the workspace purely from the OAuth `state` (no auth.uid()),
// which is exactly what a tokenized, unauthenticated client can satisfy. The
// X / TikTok / LinkedIn callbacks additionally require an authed session
// (auth.getUser()) before persisting, so they cannot be driven by an
// unauthenticated self-connect link without rebuilding their callbacks — out of
// scope, and consistent with the agency design (locked decision #2: agency
// social connection routes through Meta Business Manager).
//
// REVISIT (flagged 2026-06-06): extending self-connect to X / TikTok / LinkedIn
// means refactoring those shared OAuth callbacks to accept EITHER an authed
// session OR a self-connect token. Deferred to its own focused change with
// dedicated test coverage — a regression there breaks the channel-connect flow
// every user hits first. Tracked in the CEO plan's "Deferred" section.

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { facebookAuthorizeUrl } from "@/lib/social/facebook";
import { instagramAuthorizeUrl } from "@/lib/social/instagram";
import { threadsAuthorizeUrl } from "@/lib/social/threads";

// The channels a self-connect link can drive. Kept narrow on purpose (see the
// SCOPE note above). The keys are the public channel slugs used in the URL.
export const SELF_CONNECT_CHANNELS = ["facebook", "instagram", "threads"] as const;
export type SelfConnectChannel = (typeof SELF_CONNECT_CHANNELS)[number];

export function isSelfConnectChannel(value: string): value is SelfConnectChannel {
  return (SELF_CONNECT_CHANNELS as readonly string[]).includes(value);
}

// Per-channel wiring, mirroring each channel's authed initiate route verbatim:
// the env keys that gate "is this channel configured", the nonce cookie name
// the matching callback reads, the authorize-URL builder, and the callback path.
interface ChannelWiring {
  label: string;
  // True when the env has everything the provider dialog needs.
  isConfigured: (env: ReturnType<typeof serverEnv>) => boolean;
  // The httpOnly nonce cookie name the matching callback verifies.
  nonceCookie: string;
  // Same callback path the authed initiate uses → same redirect_uri registered
  // with the provider, so no extra Meta-app config is required.
  callbackPath: string;
  // The shared authorize-URL builder (reused, not duplicated).
  authorizeUrl: (opts: { redirectUri: string; state: string }) => string;
}

const WIRING: Record<SelfConnectChannel, ChannelWiring> = {
  facebook: {
    label: "Facebook",
    isConfigured: (env) =>
      Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_FB_LOGIN_CONFIG_ID),
    nonceCookie: "fb_oauth_nonce",
    callbackPath: "/api/oauth/facebook/callback",
    authorizeUrl: facebookAuthorizeUrl,
  },
  instagram: {
    label: "Instagram",
    isConfigured: (env) => Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
    nonceCookie: "ig_oauth_nonce",
    callbackPath: "/api/oauth/instagram/callback",
    authorizeUrl: instagramAuthorizeUrl,
  },
  threads: {
    label: "Threads",
    isConfigured: (env) => Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET),
    nonceCookie: "th_oauth_nonce",
    callbackPath: "/api/oauth/threads/callback",
    authorizeUrl: threadsAuthorizeUrl,
  },
};

export function channelLabel(channel: SelfConnectChannel): string {
  return WIRING[channel].label;
}

// Which self-connect channels are actually configured in this environment. The
// landing page uses this to only show connectable tiles (and explain when none
// are available) — same graceful-degrade as the authed channel settings page.
export function configuredSelfConnectChannels(): SelfConnectChannel[] {
  const env = serverEnv();
  return SELF_CONNECT_CHANNELS.filter((c) => WIRING[c].isConfigured(env));
}

export interface SelfConnectInitiateResult {
  redirect: NextResponse;
}

/**
 * Build the redirect that starts the OAuth dialog for `channel`, attributing the
 * resulting connection to `workspaceId`. Returns a 303 redirect (so the POST
 * from the connect tile follows as a GET — the authorize endpoints are GET-only,
 * matching the authed initiate routes) with the per-channel nonce cookie set, or
 * a redirect back to the landing page with ?error= when the channel isn't
 * configured.
 *
 * SECURITY: `workspaceId` MUST come from a validated SelfConnectContext — never
 * from the request. It is stamped into the OAuth `state`, which the existing
 * callback re-reads as the attribution target.
 */
export function startSelfConnect(opts: {
  channel: SelfConnectChannel;
  workspaceId: string;
  // The raw token, only used to build the back-to-landing error redirect so the
  // client stays on their own link if the channel is misconfigured.
  rawToken: string;
}): SelfConnectInitiateResult {
  const { channel, workspaceId, rawToken } = opts;
  const env = serverEnv();
  const wiring = WIRING[channel];
  const base = siteUrl();
  const landing = `${base}/connect/${encodeURIComponent(rawToken)}`;

  if (!wiring.isConfigured(env)) {
    return {
      redirect: NextResponse.redirect(`${landing}?error=${channel}_not_configured`, 303),
    };
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  // IDENTICAL state shape to the authed initiate routes — the callback parses
  // `state.split(":")` into [workspaceId, nonce] and trusts the first segment as
  // the attribution target.
  const state = `${workspaceId}:${nonce}`;
  const redirectUri = `${base}${wiring.callbackPath}`;
  const authorizeUrl = wiring.authorizeUrl({ redirectUri, state });

  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set(wiring.nonceCookie, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return { redirect: res };
}

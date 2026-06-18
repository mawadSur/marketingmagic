import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { linkClientInvitesOnSignup } from "@/lib/portal/manage";
import { hasClientMemberships, isClientOnlyUser } from "@/lib/workspace";
import { safeInternalPath } from "@/lib/auth/redirect";
import { friendlyAuthError } from "@/lib/auth/messages";

// Email-confirmation / magic-link / password-recovery landing.
//
// Supabase hands control back to us in a few different shapes, and the previous
// version understood only one of them (`?code=`). Every other shape — an error,
// a token_hash link, or an implicit-flow hash — fell through to a blind redirect
// to onboarding, which then bounced to /login with no message: the "white page"
// the user reported. We now handle each case explicitly and ALWAYS land the user
// on a real page with readable copy:
//   • ?error / ?error_description → expired / already-used / denied link.
//   • ?token_hash + ?type         → verifyOtp (cross-device safe; needs no PKCE
//                                   code-verifier cookie).
//   • ?code                       → exchangeCodeForSession (PKCE).
//   • none of the above           → tokens/errors are likely in the URL #hash
//                                   (implicit flow), invisible to the server, so
//                                   we hand off to the client finaliser at
//                                   /auth/confirm (the browser re-applies the
//                                   original #fragment across this redirect).

// Email OTP verification types (subset of Supabase's EmailOtpType) — cast target
// so we don't depend on the type being re-exported from the SDK entrypoint.
type EmailOtp = "signup" | "invite" | "magiclink" | "recovery" | "email_change";

function loginWithError(origin: string, raw: string | null): NextResponse {
  const msg = friendlyAuthError(raw);
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, origin));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const origin = url.origin;
  const next = safeInternalPath(params.get("next"));

  // 1) Supabase reported a failure (expired / used link, access denied, …).
  const reportedError = params.get("error_description") ?? params.get("error");
  if (reportedError) return loginWithError(origin, reportedError);

  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const otpType = params.get("type"); // signup | recovery | invite | email_change | magiclink

  // 2) Nothing actionable in the query string → the tokens (or error) are almost
  // certainly in the URL hash, which only the browser can read. Defer to the
  // client finaliser instead of bouncing through onboarding to a blank page.
  if (!code && !tokenHash) {
    return NextResponse.redirect(
      new URL(`/auth/confirm?next=${encodeURIComponent(next)}`, origin),
    );
  }

  const supabase = await supabaseServer();

  if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({
      type: otpType as EmailOtp,
      token_hash: tokenHash,
    });
    if (error) return loginWithError(origin, error.message);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return loginWithError(origin, error.message);
  }

  // Session established. Link any pending client invites (idempotent, best-effort
  // — a failure never blocks the redirect), then route ACTUAL clients to their
  // portal.
  //
  // Gate the portal hop on BOTH isClientOnlyUser() AND hasClientMemberships(),
  // mirroring blockClientsFromAgencyApp(). isClientOnlyUser() alone is true for a
  // brand-new signup too (they have no workspace or org membership *yet* — that's
  // created at /onboarding/workspace), so checking it on its own would ship every
  // fresh signup to /portal, which has no client account for them and bounces to
  // /login — i.e. the confirmation link would dead-end. Requiring a real client
  // membership lets new signups fall through to onboarding.
  //
  // EXCEPTION: a password-recovery landing must always reach /reset-password
  // regardless of account type, so we never hijack it to /portal.
  const isRecovery = otpType === "recovery" || next.startsWith("/reset-password");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.email) {
    await linkClientInvitesOnSignup(user.id, user.email);
    if (!isRecovery && (await isClientOnlyUser()) && (await hasClientMemberships())) {
      return NextResponse.redirect(new URL("/portal", origin));
    }
  }

  return NextResponse.redirect(new URL(next, origin));
}

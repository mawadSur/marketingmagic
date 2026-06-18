// Human-friendly copy for auth-link failures shown on /login and /auth/confirm.
//
// Confirmation / recovery links fail for a few boring reasons, and Supabase's
// raw strings ("invalid request: both auth code and code verifier should be
// non-empty", "otp_expired", …) help nobody. The two real-world cases worth
// naming: the link was opened in a DIFFERENT browser than the one that started
// the flow (the PKCE code-verifier cookie only exists in the original browser),
// or the link simply expired / was already used. Everything else falls back to
// the raw message — still better than a blank screen.
export function friendlyAuthError(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (!s) return "Something went wrong with that link. Please try again.";
  if (s.includes("code verifier") || s.includes("code_verifier") || s.includes("flow state")) {
    return "Open the link in the same browser you signed up with, or request a new one below.";
  }
  if (s.includes("expired") || s.includes("otp_expired")) {
    return "That link has expired. Request a new one below.";
  }
  if (s.includes("access_denied") || s.includes("already") || s.includes("invalid") || s.includes("not found")) {
    return "That link is no longer valid. Try logging in, or request a new one below.";
  }
  // Unknown error — surface it rather than swallowing it into a white page.
  return raw ?? "Something went wrong with that link. Please try again.";
}

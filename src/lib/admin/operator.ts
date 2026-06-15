// Operator (founder/staff) gate for internal-only pages like /admin/metrics.
//
// The app has no user-role system — every authed user is a customer. Internal
// dashboards are gated by an EMAIL ALLOWLIST in env, not a DB role, so there's
// nothing to migrate and the default is safe: if ADMIN_EMAILS is unset or empty,
// isOperator() returns false for everyone and the page 404s. Set it in Vercel:
//
//   ADMIN_EMAILS="you@example.com,cofounder@example.com"
//
// Read lazily from process.env (same posture as the Stripe price helpers) so a
// missing var degrades gracefully instead of throwing at import time.
export function operatorEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  return operatorEmails().includes(email.trim().toLowerCase());
}

import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { linkClientInvitesOnSignup } from "@/lib/portal/manage";
import { isClientOnlyUser } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/onboarding/workspace";

  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin));
    }

    // Client ACCOUNTS (migration 037): the moment a session exists, link any
    // PENDING client invites for this email into client_memberships (idempotent,
    // service-role). This turns an invited client into an account scoped to the
    // invited workspace's report. Best-effort — a failure never blocks login.
    // A client-only user (no agency footprint) is then routed to the client
    // portal instead of the agency onboarding/app.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.email) {
      await linkClientInvitesOnSignup(user.id, user.email);
      if (await isClientOnlyUser()) {
        return NextResponse.redirect(new URL("/portal", url.origin));
      }
    }
  }

  return NextResponse.redirect(new URL(next, url.origin));
}

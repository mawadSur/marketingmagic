import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";
import { Logo } from "@/components/ui/logo";

export default async function ResetPasswordPage() {
  // Reaching this page requires the recovery session that /auth/callback mints
  // from the email link. No session → the link was bad/expired or opened in a
  // different browser; send them to request a fresh one rather than show a form
  // that can't submit.
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(
      "/forgot-password?error=" +
        encodeURIComponent("Your reset link is invalid or has expired. Request a new one."),
    );
  }

  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Link
            href="/"
            className="mx-auto inline-flex rounded-lg transition-opacity duration-200 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="marketingmagic home"
          >
            <Logo variant="full" size="lg" />
          </Link>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Choose a new password</h1>
            <p className="text-sm text-foreground/80">
              Pick a strong password you don&apos;t use anywhere else.
            </p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <ResetPasswordForm />
        </div>
      </div>
    </main>
  );
}

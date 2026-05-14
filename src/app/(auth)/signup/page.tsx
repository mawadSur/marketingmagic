import Link from "next/link";
import { Suspense } from "react";
import { SignupForm } from "./signup-form";
import { Skeleton } from "@/components/ui/skeleton";

export default function SignupPage() {
  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <Link
            href="/"
            className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-foreground to-foreground/70 text-sm font-bold text-background transition-opacity duration-200 hover:opacity-90"
            aria-label="marketingmagic home"
          >
            mm
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
            <p className="text-sm text-muted-foreground">
              Start auto-generating posting plans. No credit card to try it.
            </p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <Suspense fallback={<SignupFallback />}>
            <SignupForm />
          </Suspense>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 transition-colors duration-200 hover:underline"
          >
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}

function SignupFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-12" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

// Branded 404. Shown by Next for unmatched routes and by the 8 explicit
// notFound() callers across the app. Mirrors the centered-card auth language.
export default function NotFound() {
  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Link
          href="/"
          className="mx-auto inline-flex rounded-lg transition-opacity duration-200 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="marketingmagic home"
        >
          <Logo variant="full" size="lg" />
        </Link>
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </main>
  );
}

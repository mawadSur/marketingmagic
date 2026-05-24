import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data deletion — marketingmagic",
  description:
    "Status page for a marketingmagic data-deletion request. Surfaced when Meta hands users off after removing the app.",
};

export const dynamic = "force-static";

// Public, unauthenticated status page Meta opens after a user removes the
// app from their Facebook account. We can't show per-request status from
// here without auth, so the page is intentionally informational: it
// confirms we received the callback and tells the user how to follow up.
//
// The optional ?code= query param echoes the confirmation_code we returned
// from /api/data-deletion. We display it as a reference so the user can
// quote it in any follow-up email.

export default async function DataDeletionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const params = await searchParams;
  const code = params.code?.trim() || null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="space-y-2">
        <Link href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          ← marketingmagic
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Data deletion request</h1>
        <p className="text-sm text-muted-foreground">
          What happens when you remove marketingmagic from your Facebook account.
        </p>
      </header>

      <div className="mt-10 space-y-6 text-sm leading-relaxed">
        {code ? (
          <div className="rounded-md border bg-card p-4">
            <p className="text-xs text-muted-foreground">Your confirmation code</p>
            <p className="mt-1 font-mono text-sm break-all">{code}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Keep this if you need to ask us about the request.
            </p>
          </div>
        ) : null}

        <section className="space-y-2">
          <h2 className="text-base font-medium">What we&apos;ll delete</h2>
          <ul className="list-disc pl-5">
            <li>
              Any Instagram or Threads access tokens we&apos;re holding for the Facebook account
              you just disconnected.
            </li>
            <li>
              The associated rows from our <code>social_accounts</code> table so we no longer
              attempt to publish to that account.
            </li>
            <li>
              Cached engagement metrics tied specifically to that Meta account&apos;s posts.
            </li>
          </ul>
          <p>
            Posts you&apos;ve already published to Instagram or Threads remain on those platforms
            — only Meta can remove them. You can delete them from the Instagram or Threads app
            directly.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Timeline</h2>
          <p>
            We process deletion requests within 30 days of receipt. Most are handled within a
            few business days.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Want to delete more?</h2>
          <p>
            The Meta callback only covers your Instagram and Threads connection. To delete your
            entire marketingmagic account (workspaces, drafts, posts, and every other social
            connection), email{" "}
            <a className="underline-offset-2 hover:underline" href="mailto:mawad10101@gmail.com">
              mawad10101@gmail.com
            </a>{" "}
            from the address on file. See our{" "}
            <Link href="/privacy" className="underline-offset-2 hover:underline">
              Privacy Policy
            </Link>{" "}
            for the full retention details.
          </p>
        </section>
      </div>
    </main>
  );
}

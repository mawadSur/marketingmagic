import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — marketingmagic",
  description:
    "How marketingmagic handles your data, what we collect, how to request deletion, and which third parties we share with.",
};

export const dynamic = "force-static";

// Effective date — bump this whenever the policy changes materially.
// Meta App Review checks this is present and dated within a reasonable window.
const EFFECTIVE_DATE = "2026-05-24";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="space-y-2">
        <Link href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          ← marketingmagic
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>
      </header>

      <div className="mt-10 max-w-none space-y-8 text-sm leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-base font-medium">Who we are</h2>
          <p>
            marketingmagic (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is an auto-posting tool that
            helps founders publish to social networks on a schedule. We&apos;re a small
            team. If you need to reach a human about privacy, email{" "}
            <a className="underline-offset-2 hover:underline" href="mailto:mawad10101@gmail.com">
              mawad10101@gmail.com
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">What we collect</h2>
          <ul className="list-disc pl-5">
            <li>
              <strong>Account data:</strong> your email address and a hashed password (managed by
              Supabase Auth). We never see or store your plain-text password.
            </li>
            <li>
              <strong>Social account credentials:</strong> when you connect X, LinkedIn, Bluesky,
              Instagram, Threads, Facebook, or TikTok, we receive OAuth tokens (or app passwords
              for Bluesky) from the provider. These are stored encrypted server-side and never
              exposed to the browser.
            </li>
            <li>
              <strong>Content you create:</strong> posts you write or generate, drafts, themes,
              and any source material (URLs, transcripts, audio notes) you provide.
            </li>
            <li>
              <strong>Public post metrics:</strong> impressions, likes, replies, etc. that the
              social platforms expose for posts you ship through us.
            </li>
            <li>
              <strong>Usage telemetry:</strong> standard server logs (IP, user-agent, paths) for
              security and debugging. Vercel Analytics for aggregate page-view counts. No
              third-party advertising trackers.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">How we use it</h2>
          <ul className="list-disc pl-5">
            <li>To publish posts to the social networks you&apos;ve connected.</li>
            <li>To generate post drafts, themes, and analytics for your workspace.</li>
            <li>To pull back engagement metrics for posts we published.</li>
            <li>To send transactional email (password reset, billing receipts).</li>
            <li>To debug errors and prevent abuse.</li>
          </ul>
          <p>
            We do <strong>not</strong> sell your data. We do <strong>not</strong> use your post
            content to train AI models. We do <strong>not</strong> share your social account
            tokens with anyone outside the providers themselves.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Third parties we share with</h2>
          <p>
            These are the subprocessors that handle slices of the service. We share only what each
            needs to do its job.
          </p>
          <ul className="list-disc pl-5">
            <li>
              <strong>Supabase</strong> — database + auth (everything we store).
            </li>
            <li>
              <strong>Vercel</strong> — hosting + analytics (aggregated traffic).
            </li>
            <li>
              <strong>OpenAI / Anthropic</strong> — drafting and editing post text. Content sent
              for generation is not stored by them beyond their abuse-detection windows.
            </li>
            <li>
              <strong>Social platforms</strong> (X, LinkedIn, Meta for Instagram + Threads +
              Facebook, Bluesky, TikTok) — for publishing and reading public metrics on your
              behalf.
            </li>
            <li>
              <strong>Stripe</strong> — payment processing (if you&apos;re on a paid plan).
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Meta-platform data (Instagram + Threads)</h2>
          <p>
            When you connect an Instagram or Threads account, Meta returns an access token tied to
            your business account. We store that token encrypted server-side and use it only to
            publish posts you authorize, list your business accounts, and read engagement on
            posts we publish.
          </p>
          <p>
            We honor Meta&apos;s Data Deletion callback. If you remove marketingmagic from your
            Facebook account, Meta will notify us automatically and we&apos;ll delete the
            associated tokens and account record within 30 days. You can also request deletion
            directly:{" "}
            <Link className="underline-offset-2 hover:underline" href="/data-deletion">
              /data-deletion
            </Link>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Retention</h2>
          <p>
            Account and post data live as long as your account exists. When you delete your
            workspace or your account, we cascade-delete all rows tied to it from our database
            within 30 days. Server logs roll off on a 90-day window.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Your rights</h2>
          <ul className="list-disc pl-5">
            <li>Access and export your data — email us and we&apos;ll bundle it up.</li>
            <li>Correct anything that&apos;s wrong.</li>
            <li>
              Delete your account and everything tied to it — email{" "}
              <a
                className="underline-offset-2 hover:underline"
                href="mailto:mawad10101@gmail.com"
              >
                mawad10101@gmail.com
              </a>{" "}
              or use the in-app delete affordance.
            </li>
            <li>Disconnect any social account at any time from /settings/channels.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Cookies</h2>
          <p>
            We set a session cookie (Supabase auth), a workspace cookie that remembers which
            workspace you last opened, and short-lived OAuth state cookies during connect flows.
            We don&apos;t use third-party tracking cookies.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Changes</h2>
          <p>
            If we change this policy materially, we&apos;ll update the effective date at the top
            and notify you by email before the change takes effect.
          </p>
        </section>
      </div>
    </main>
  );
}

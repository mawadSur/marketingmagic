import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — marketingmagic",
  description:
    "The terms that govern your use of marketingmagic: your account, acceptable use, content licensing, third-party platforms, billing, and liability.",
};

export const dynamic = "force-static";

// Effective date — bump this whenever the terms change materially. Platform
// app reviews (Meta, TikTok, X) check this is present and dated.
const EFFECTIVE_DATE = "2026-06-02";

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="space-y-2">
        <Link href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          ← marketingmagic
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>
      </header>

      <div className="prose prose-sm mt-10 max-w-none space-y-8 text-sm leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-base font-medium">Agreement to these terms</h2>
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of
            marketingmagic (&ldquo;marketingmagic&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), an
            auto-posting tool that helps founders draft, schedule, and publish content to the
            social networks they connect. By creating an account or using the service, you agree
            to these Terms. If you don&apos;t agree, don&apos;t use the service. Questions? Email{" "}
            <a className="underline-offset-2 hover:underline" href="mailto:mawad10101@gmail.com">
              mawad10101@gmail.com
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Your account</h2>
          <ul className="list-disc pl-5">
            <li>
              You must be at least 18 years old and able to form a binding contract to use
              marketingmagic.
            </li>
            <li>
              You&apos;re responsible for keeping your login credentials secure and for all
              activity under your account.
            </li>
            <li>
              You must provide accurate information and keep it up to date. You&apos;re responsible
              for the social accounts you connect and for having the right to publish to them.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">The service</h2>
          <p>
            marketingmagic lets you write or generate posts, build a content schedule, and publish
            on your behalf to social networks you connect — currently X, LinkedIn, Bluesky,
            Instagram, Threads, Facebook, and TikTok. You keep an approval queue and a kill switch:
            you decide what ships. We may add, change, or remove features over time.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Acceptable use</h2>
          <p>You agree not to use marketingmagic to:</p>
          <ul className="list-disc pl-5">
            <li>
              Post content that is illegal, infringing, deceptive, hateful, harassing, or that
              violates anyone&apos;s rights.
            </li>
            <li>
              Send spam, run engagement-farming schemes, or otherwise abuse the connected
              platforms or their users.
            </li>
            <li>
              Violate the terms, policies, or rate limits of any social platform you connect (see
              below).
            </li>
            <li>
              Attempt to breach, probe, or disrupt the service, reverse-engineer it, or access
              data that isn&apos;t yours.
            </li>
            <li>
              Impersonate others or misrepresent your affiliation with any person or organization.
            </li>
          </ul>
          <p>
            We may suspend or terminate accounts that violate these rules, with or without notice.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Your content</h2>
          <p>
            You own the content you create or upload. You grant marketingmagic a limited,
            non-exclusive license to store, process, and transmit that content solely to operate
            the service — for example, to generate drafts, render media, and publish posts to the
            platforms you authorize. We do <strong>not</strong> sell your content, and we do{" "}
            <strong>not</strong> use your post content to train AI models. This license ends when
            you delete the content or your account, subject to the retention windows in our{" "}
            <Link className="underline-offset-2 hover:underline" href="/privacy">
              Privacy Policy
            </Link>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Third-party platforms</h2>
          <p>
            When you connect a social account, you authorize marketingmagic to act on your behalf
            through that platform&apos;s API — publishing posts you approve and reading public
            metrics on posts we publish. Your use of each platform remains subject to that
            platform&apos;s own terms, including:
          </p>
          <ul className="list-disc pl-5">
            <li>
              <strong>TikTok</strong> — the{" "}
              <a
                className="underline-offset-2 hover:underline"
                href="https://www.tiktok.com/legal/page/global/terms-of-service/en"
                target="_blank"
                rel="noopener noreferrer"
              >
                TikTok Terms of Service
              </a>{" "}
              and the TikTok Developer / Content Posting policies.
            </li>
            <li>
              <strong>Meta</strong> (Instagram, Threads, Facebook) — the Meta Platform Terms and
              each product&apos;s usage policies.
            </li>
            <li>
              <strong>X, LinkedIn, Bluesky</strong> — each platform&apos;s developer and user
              terms.
            </li>
          </ul>
          <p>
            We&apos;re not responsible for changes a platform makes to its API, for content the
            platform removes, or for actions a platform takes against your account. You can
            disconnect any platform at any time from{" "}
            <span className="font-mono">/settings/channels</span>.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Plans &amp; billing</h2>
          <ul className="list-disc pl-5">
            <li>
              Paid plans are billed through Stripe. By subscribing you authorize recurring charges
              until you cancel.
            </li>
            <li>
              You can cancel anytime; access continues through the end of the current billing
              period and is not pro-rated unless required by law.
            </li>
            <li>
              Some features rely on your own third-party API keys (e.g. your LLM and stock-media
              keys for video). You pay those providers directly and are responsible for their
              usage and costs.
            </li>
            <li>We may change pricing with reasonable notice before your next renewal.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Disclaimers</h2>
          <p>
            The service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without
            warranties of any kind. We don&apos;t guarantee that posts will publish without error,
            that a platform will accept every post, or that the service will be uninterrupted.
            AI-generated drafts may contain mistakes — you&apos;re responsible for reviewing what
            you publish.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, marketingmagic will not be liable for any
            indirect, incidental, special, or consequential damages, or for lost profits, data, or
            goodwill, arising from your use of the service. Our total liability for any claim is
            limited to the amount you paid us in the twelve months before the claim.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Termination</h2>
          <p>
            You can stop using the service and delete your account at any time. We may suspend or
            terminate your access if you violate these Terms or to comply with the law. On
            termination we delete your data per the retention windows in our{" "}
            <Link className="underline-offset-2 hover:underline" href="/privacy">
              Privacy Policy
            </Link>
            ; you can also request deletion at{" "}
            <Link className="underline-offset-2 hover:underline" href="/data-deletion">
              /data-deletion
            </Link>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Changes</h2>
          <p>
            If we change these Terms materially, we&apos;ll update the effective date above and
            notify you by email before the change takes effect. Continuing to use the service after
            a change means you accept the updated Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-medium">Contact</h2>
          <p>
            Questions about these Terms? Email{" "}
            <a className="underline-offset-2 hover:underline" href="mailto:mawad10101@gmail.com">
              mawad10101@gmail.com
            </a>
            . See also our{" "}
            <Link className="underline-offset-2 hover:underline" href="/privacy">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </div>
    </main>
  );
}

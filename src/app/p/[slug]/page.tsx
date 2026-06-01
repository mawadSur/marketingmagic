import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge, channelLabel } from "@/components/ui/badge";
import { getPreviewShare } from "@/lib/growth/preview-share";
import { track, hashHandle } from "@/lib/preview/analytics";
import { PreviewPlanView } from "./plan-view";

// Persisted, read-only shared preview. Unlike /preview/[token] (which carries
// the plan in a signed URL token), /p/<slug> reads the plan from preview_shares
// by its unguessable slug. This is the link that gets pasted into social feeds,
// so it's INDEXABLE and carries dynamic OpenGraph tags (the OG image is served
// by the sibling opengraph-image route) for a rich unfurl.

export const dynamic = "force-dynamic";

// Build OG/Twitter metadata so the link unfurls as
// "Here's the content plan marketingmagic made for @brand". The image is the
// co-located opengraph-image route (Next picks it up by convention), so we only
// set the textual tags here.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const share = await getPreviewShare(slug);
  if (!share) {
    return { title: "Preview not found — marketingmagic", robots: { index: false } };
  }
  const title = `The content plan marketingmagic made for @${share.handle}`;
  const description =
    share.plan.overview?.slice(0, 200) ||
    `A 1-week ${channelLabel(share.channel)} posting plan written in @${share.handle}'s voice.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: `/p/${slug}`,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SharedPreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!slug) notFound();

  const share = await getPreviewShare(slug);
  if (!share) return <NotAvailableView />;

  track({
    stage: "preview_share_view",
    channel: share.channel,
    handle_hash: hashHandle(share.handle),
    meta: { posts: share.plan.posts.length, source: share.source },
  });

  return (
    <PreviewPlanView
      payload={share}
      badge={<Badge variant="info">Shared preview</Badge>}
      footer={
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Want one of these for your brand?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            marketingmagic wrote this {channelLabel(share.channel)} plan in @
            {share.handle}&apos;s voice in about 30 seconds. Drop your own handle
            and see yours — no signup required.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href="/start"
              className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Make my plan
            </Link>
            <Link
              href="/"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              What is marketingmagic?
            </Link>
          </div>
        </section>
      }
    />
  );
}

function NotAvailableView() {
  return (
    <main className="container mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 py-16 text-center">
      <Badge variant="warning">Preview unavailable</Badge>
      <h1 className="text-2xl font-semibold tracking-tight">This shared plan isn&apos;t available</h1>
      <p className="text-sm text-muted-foreground">
        The link may have expired or been mistyped. Generate a fresh plan — it
        takes about 30 seconds.
      </p>
      <Link
        href="/start"
        className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Generate a new preview
      </Link>
    </main>
  );
}

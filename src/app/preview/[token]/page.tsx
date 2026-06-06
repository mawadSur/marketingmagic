import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge, ChannelBadge, channelLabel } from "@/components/ui/badge";
import { verifyPreviewToken } from "@/lib/preview/token";
import { track, hashHandle } from "@/lib/preview/analytics";
import { SignupCtaLink } from "./signup-cta";
import { SharePlan } from "./share-plan";

export const metadata: Metadata = {
  title: "Your preview plan — marketingmagic",
  robots: { index: false, follow: false },
};

// Page is fully server-rendered. The token IS the storage; no DB read.
// `next/navigation`'s notFound() is reserved for malformed tokens. Expired /
// bad-signature tokens get a friendly recovery UI instead of a 404 — that's
// the difference between "you mistyped the URL" and "your preview aged out."

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token) notFound();

  const result = verifyPreviewToken(token);
  if (!result.ok) {
    return <RecoveryView reason={result.reason} />;
  }
  const { payload } = result;
  track({
    stage: "preview_view",
    channel: payload.channel,
    handle_hash: hashHandle(payload.handle),
    meta: { source: payload.source, posts: payload.plan.posts.length },
  });

  const post = payload.plan.posts;
  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <main className="relative flex min-h-screen flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-muted/40 via-background to-background"
      />
      <div className="container mx-auto flex flex-1 flex-col gap-8 py-12 max-w-3xl">
        <header className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="info">Preview · expires in 24h</Badge>
            <ChannelBadge channel={payload.channel} />
            <span aria-hidden>·</span>
            <span>@{payload.handle}</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {payload.plan.plan_name}
          </h1>
          <p className="text-sm text-muted-foreground">{payload.plan.overview}</p>
          <p className="text-xs text-muted-foreground">{payload.voice_summary}</p>
        </header>

        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">Keep this plan</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Sign up to lock in this plan, connect your accounts, and start
                scheduling. Your preview link expires in 24 hours.
              </p>
            </div>
            <SignupCtaLink token={token} channel={payload.channel} handleHash={hashHandle(payload.handle)} />
          </div>
          <div className="mt-4 border-t pt-4">
            <SharePlan token={token} channel={payload.channel} />
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {post.length} posts · 1-week teaser
          </h2>
          <ol className="space-y-4">
            {post.map((p, idx) => (
              <li key={idx} className="rounded-lg border bg-card p-5 shadow-sm">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <ChannelBadge channel={p.channel} />
                    <Badge variant="muted">{p.theme}</Badge>
                  </div>
                  <span>{formatDate(p.suggested_scheduled_at)}</span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{p.text}</p>
                {p.rationale ? (
                  <details className="mt-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Why this post</summary>
                    <p className="mt-1 leading-relaxed">{p.rationale}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Like what you see?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign up to keep this {channelLabel(payload.channel)} plan, add more
            channels, schedule the posts, and let marketingmagic auto-generate
            future weeks in your voice.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <SignupCtaLink
              token={token}
              channel={payload.channel}
              handleHash={hashHandle(payload.handle)}
              variant="primary"
            />
            <Link href="/start" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
              Try a different handle
            </Link>
          </div>
        </section>

        <footer className="pt-2 text-xs text-muted-foreground">
          Your preview lives entirely in the URL — we didn't save your handle
          or posts. Sign up to start storing plans.
        </footer>
      </div>
    </main>
  );
}

function RecoveryView({ reason }: { reason: "malformed" | "bad_signature" | "expired" }) {
  const copy =
    reason === "expired"
      ? "This preview expired (24h max). Generate a fresh one — it takes ~30 seconds."
      : "This preview link looks broken. Generate a new one to continue.";
  return (
    <main className="container mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 py-16 text-center">
      <Badge variant="warning">Preview unavailable</Badge>
      <h1 className="text-2xl font-semibold tracking-tight">Preview not available</h1>
      <p className="text-sm text-muted-foreground">{copy}</p>
      <div className="flex items-center gap-3">
        <Link
          href="/start"
          className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Generate a new preview
        </Link>
        <Link href="/signup" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Or sign up
        </Link>
      </div>
    </main>
  );
}

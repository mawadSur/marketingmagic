import { Badge, ChannelBadge } from "@/components/ui/badge";
import type { PreviewSharePayload } from "@/lib/db/types";

// Read-only renderer for a shared preview plan (/p/<slug>). Pure presentation,
// no token / no signup-CTA wiring — the shared view is intentionally a
// look-don't-touch teaser with a single "make your own" call to action passed
// in as `footer`. Mirrors the layout of /preview/[token] so a shared plan looks
// identical to the one the original visitor saw.
export function PreviewPlanView({
  payload,
  badge,
  footer,
}: {
  payload: PreviewSharePayload;
  badge: React.ReactNode;
  footer: React.ReactNode;
}) {
  const posts = payload.plan.posts;
  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
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
            {badge}
            <ChannelBadge channel={payload.channel} />
            <span aria-hidden>·</span>
            <span>@{payload.handle}</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{payload.plan.plan_name}</h1>
          <p className="text-sm text-muted-foreground">{payload.plan.overview}</p>
          <p className="text-xs text-muted-foreground">{payload.voice_summary}</p>
        </header>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {posts.length} posts · 1-week teaser
          </h2>
          <ol className="space-y-4">
            {posts.map((p, idx) => (
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

        {footer}
      </div>
    </main>
  );
}

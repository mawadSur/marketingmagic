import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { tierFor, type PlanId } from "@/lib/billing/tiers";
import { ChannelBadge, statusBadgeVariant, Badge, statusBadgeLabel } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

// Tiles in the "Add a channel" grid. Each OAuth channel has an `initiate`
// path the tile POSTs to — that way the listing acts as a one-click connect
// (no per-channel page hop required). Bluesky uses an app-password paste
// instead of OAuth, so it stays a link to its own page where the input form
// lives. The per-channel pages still exist for users who land there directly
// or follow a deep link from elsewhere in the app.
const CONNECTORS = [
  { slug: "x", label: "Connect X", initiate: "/api/oauth/x/initiate" },
  { slug: "linkedin", label: "Connect LinkedIn", initiate: "/api/oauth/linkedin/initiate" },
  { slug: "threads", label: "Connect Threads", initiate: "/api/oauth/threads/initiate" },
  { slug: "instagram", label: "Connect Instagram", initiate: "/api/oauth/instagram/initiate" },
  { slug: "facebook", label: "Connect Facebook", initiate: "/api/oauth/facebook/initiate" },
  { slug: "tiktok", label: "Connect TikTok", initiate: "/api/oauth/tiktok/initiate" },
  { slug: "bluesky", label: "Connect Bluesky", initiate: null }, // app-password flow, not OAuth
] as const;

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const params = await searchParams;
  const supabase = await supabaseServer();
  const { data: accounts } = await supabase
    .from("social_accounts_safe")
    .select("*")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: true });

  const hasAny = accounts && accounts.length > 0;
  const connectedCount = accounts?.length ?? 0;

  // Read the plan via service role so we get the billing column even when the
  // user session client doesn't carry it. The OAuth callbacks ALREADY enforce
  // the channel quota server-side (see assertWithinChannelQuota in
  // lib/billing/limits.ts) — this banner is the UX shortcut that explains
  // *why* connecting more would fail, before the user round-trips through
  // the provider's consent screen and gets bounced back with ?error=.
  const svc = supabaseService();
  const { data: wsRow } = await svc
    .from("workspaces")
    .select("plan")
    .eq("id", ws.id)
    .maybeSingle();
  const plan = (wsRow?.plan as PlanId | undefined) ?? "hobby";
  const tier = tierFor(plan);
  const channelLimit = tier.limits.channels;
  const atChannelLimit = channelLimit !== -1 && connectedCount >= channelLimit;

  // Post-connect guidance. OAuth callbacks all land here, but connecting a
  // channel is only step one — users were getting stranded with no nudge
  // toward the brief and first plan. Compute what's still missing so we can
  // point them at the next step: connect → brief → plan. Cheap existence
  // checks (select id, limit 1).
  const [briefRes, planRes] = await Promise.all([
    supabase.from("brand_briefs").select("id").eq("workspace_id", ws.id).maybeSingle(),
    supabase.from("posting_plans").select("id").eq("workspace_id", ws.id).limit(1).maybeSingle(),
  ]);
  const hasBrief = Boolean(briefRes.data);
  const hasPlan = Boolean(planRes.data);
  // The next incomplete onboarding step, or null when fully set up. We only
  // surface this once at least one channel is connected (somewhere to post).
  const nextStep: { href: string; title: string; body: string; cta: string } | null =
    hasAny && !hasBrief
      ? {
          href: "/onboarding/wizard?step=1",
          title: "Next: tell us about your business",
          body:
            "Add a short brief — what you do, who you serve, and how you sound — so we can draft posts in your voice. Paste your site and we'll fill most of it in.",
          cta: "Add your business info",
        }
      : hasAny && hasBrief && !hasPlan
        ? {
            href: "/onboarding/wizard?step=3",
            title: "Next: plan your first week",
            body:
              "Your brief is in. Let's draft your first week of posts — everything lands in your queue for approval before anything publishes.",
            cta: "Create your plan",
          }
        : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Connected social accounts. Credentials live server-side only — never exposed to the browser.
        </p>
      </header>

      {/* OAuth callbacks (X, LinkedIn, IG, Threads…) bounce back here with
          ?connected=… or ?error=…. Surface them so users aren't silently
          stranded after an OAuth round-trip. */}
      {params.connected ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          <p className="font-medium capitalize">{params.connected} connected.</p>
        </div>
      ) : null}
      {params.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Connection failed.</p>
          <p className="mt-1 text-muted-foreground break-words">{params.error}</p>
        </div>
      ) : null}

      {/* Guided next step. Connecting a channel is only the first move — point
          the user at the brief, then the first plan, so they don't stall on
          this page after an OAuth round-trip. Disappears once both are done. */}
      {nextStep ? (
        <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-base font-medium">{nextStep.title}</p>
            <p className="max-w-xl text-sm text-muted-foreground">{nextStep.body}</p>
          </div>
          <Link
            href={nextStep.href}
            className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {nextStep.cta} →
          </Link>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="text-base font-medium">Connected</h2>
          {hasAny ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {accounts!.length} {accounts!.length === 1 ? "account" : "accounts"}
            </span>
          ) : null}
        </div>
        {hasAny ? (
          <ul className="divide-y rounded-lg border bg-card">
            {accounts!.map((a) => (
              <li key={a.id} className="transition-colors duration-200 hover:bg-muted/30">
                <Link
                  href={`/settings/channels/${a.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <ChannelBadge channel={a.channel} />
                    <span className="font-medium">@{a.handle}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.trust_mode
                        ? `auto-post (${a.successful_post_count}/${a.trust_threshold})`
                        : "manual approval"}
                    </span>
                  </div>
                  <Badge variant={statusBadgeVariant(a.status)}>
                    {statusBadgeLabel(a.status)}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="plug"
            title="No channels connected yet."
            description="Pick a network below — credentials are stored encrypted, server-side only."
          />
        )}
      </section>

      {atChannelLimit ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium">
                Channel limit reached on the {tier.name} plan.
              </p>
              <p className="text-muted-foreground">
                You&apos;re using {connectedCount} of {channelLimit} connected{" "}
                {channelLimit === 1 ? "channel" : "channels"}. Upgrade to connect more.
              </p>
            </div>
            <Link
              href="/settings/billing"
              className="shrink-0 inline-flex items-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Upgrade plan
            </Link>
          </div>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-base font-medium">Add a channel</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CONNECTORS.map((c) =>
            c.initiate ? (
              // OAuth channel: tile is a POST form to the initiate route.
              // One-click connect — submitting kicks the user straight to
              // the provider's authorize screen. When at the channel cap we
              // disable the submit button so the user doesn't round-trip to
              // the provider just to get bounced back with ?error=quota.
              <form key={c.slug} action={c.initiate} method="post">
                <button
                  type="submit"
                  disabled={atChannelLimit}
                  className="card-hover flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card"
                  aria-disabled={atChannelLimit}
                >
                  <ChannelBadge channel={c.slug} />
                  <span>{c.label}</span>
                  <span aria-hidden className="ml-auto text-muted-foreground">→</span>
                </button>
              </form>
            ) : atChannelLimit ? (
              // Bluesky tile mirrors the disabled state of the OAuth tiles
              // when at-cap, so the grid stays visually uniform.
              <span
                key={c.slug}
                aria-disabled="true"
                className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-sm font-medium opacity-50 cursor-not-allowed"
              >
                <ChannelBadge channel={c.slug} />
                <span>{c.label}</span>
                <span aria-hidden className="ml-auto text-muted-foreground">→</span>
              </span>
            ) : (
              // Bluesky: link to the channel page where the handle +
              // app-password form lives.
              <Link
                key={c.slug}
                href={`/settings/channels/${c.slug}`}
                className="card-hover flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-sm font-medium"
              >
                <ChannelBadge channel={c.slug} />
                <span>{c.label}</span>
                <span aria-hidden className="ml-auto text-muted-foreground">→</span>
              </Link>
            ),
          )}
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { serverEnv } from "@/lib/env";
import { tierFor } from "@/lib/billing/tiers";
import { overLimitAccountIds } from "@/lib/billing/limits";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";
import { displayHandle } from "@/lib/channels/registry";
import { ChannelBadge, statusBadgeVariant, Badge, statusBadgeLabel } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FirstPlanCta } from "./first-plan-cta";

export const dynamic = "force-dynamic";

// Tiles in the "Add a channel" grid. Each OAuth channel has an `initiate`
// path the tile POSTs to — that way the listing acts as a one-click connect
// (no per-channel page hop required). Bluesky uses an app-password paste
// instead of OAuth, so it stays a link to its own page where the input form
// lives. The per-channel pages still exist for users who land there directly
// or follow a deep link from elsewhere in the app.
// `comingSoon` channels are awaiting external platform approval (LinkedIn's
// Community Management API review; TikTok's app audit), so connecting would
// dead-end on a provider error. We surface them as a disabled "Coming soon"
// tile instead of a live connect button. Flip the flag off once approved.
const CONNECTORS = [
  { slug: "x", label: "Connect X", initiate: "/api/oauth/x/initiate" },
  { slug: "linkedin", label: "Connect LinkedIn", initiate: "/api/oauth/linkedin/initiate", comingSoon: true },
  { slug: "threads", label: "Connect Threads", initiate: "/api/oauth/threads/initiate" },
  { slug: "instagram", label: "Connect Instagram", initiate: "/api/oauth/instagram/initiate" },
  { slug: "facebook", label: "Connect Facebook", initiate: "/api/oauth/facebook/initiate" },
  { slug: "tiktok", label: "Connect TikTok", initiate: "/api/oauth/tiktok/initiate", comingSoon: true },
  // YouTube is video-only via the Data API v3 (Google OAuth). Live use needs a
  // verified Google Cloud project + YOUTUBE_CLIENT_ID/SECRET; the tile is hidden
  // entirely when that env is unset (see oauthEnvPrefix gating below).
  { slug: "youtube", label: "Connect YouTube", initiate: "/api/oauth/youtube/initiate" },
  { slug: "bluesky", label: "Connect Bluesky", initiate: null }, // app-password flow, not OAuth
] as const;

// Channels whose connect tile is gated on OAuth env presence. When the matching
// keys are unset, the channel degrades gracefully — its tile is hidden from the
// "Add a channel" grid (mirrors the registry's `oauthEnvPrefix` contract) so a
// user never round-trips to a provider the deployment can't actually talk to.
// Currently only YouTube opts into UI-level env gating; the other OAuth tiles
// rely on their initiate route redirecting with `_not_configured`.
function channelOauthConfigured(slug: string): boolean {
  if (slug !== "youtube") return true;
  const env = serverEnv();
  return Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET);
}

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const params = await searchParams;
  const supabase = await supabaseServer();
  // Exclude disconnected accounts — a disconnected channel reads as "not
  // connected" everywhere: it drops off this list and frees its quota slot so
  // the user can reconnect from the "Add a channel" grid below. The soft row
  // lingers only so post history (FK on delete restrict) survives.
  const { data: accounts } = await supabase
    .from("social_accounts_safe")
    .select("*")
    .eq("workspace_id", ws.id)
    .neq("status", "disconnected")
    .order("created_at", { ascending: true });

  const hasAny = accounts && accounts.length > 0;
  const connectedCount = accounts?.length ?? 0;

  // Channels that already have a connected account. We hide their tile in the
  // "Add a channel" grid below so a connected network doesn't show up as still-
  // connectable — the user manages it from the "Connected" list instead. (The
  // per-channel deep-link pages still exist for reconnect/advanced flows.)
  const connectedChannels = new Set((accounts ?? []).map((a) => a.channel));

  // Resolve the EFFECTIVE plan (not the raw workspaces.plan column) so the
  // banner matches what assertWithinChannelQuota actually enforces. This is the
  // same resolver the OAuth callbacks use, so it accounts for org inheritance
  // AND account-level sharing (a paid plan on another workspace this user owns
  // lifts this one) — without it the banner would wrongly say "Free, 1 channel"
  // on a workspace that's actually covered by the user's subscription. The
  // banner is the UX shortcut that explains *why* connecting more would fail,
  // before the user round-trips through the provider's consent screen and gets
  // bounced back with ?error=.
  const svc = supabaseService();
  const plan = await resolvePlanForWorkspace(ws.id);
  const tier = tierFor(plan);
  const channelLimit = tier.limits.channels;
  const atChannelLimit = channelLimit !== -1 && connectedCount >= channelLimit;

  // SOFT channel-cap enforcement (retroactive). assertWithinChannelQuota blocks
  // NEW connects, but a workspace can already be OVER the cap — e.g. after a plan
  // downgrade or a Stripe lapse that maps the effective plan to hobby. Those
  // over-limit accounts stay connected but are BLOCKED from publishing + auto-
  // actions by the crons (see the publish + poll-interactions routes). Mark them
  // here so the UI matches reality. overLimitAccountIds is the SAME helper those
  // crons use — single source of truth, computed-on-read from the EFFECTIVE plan
  // (resolvePlanForWorkspace) + oldest-N-kept ordering — so the set the UI shows
  // is exactly the set the crons enforce. Empty for unlimited plans / at-or-under
  // the cap, so within-limit accounts render unchanged.
  const overLimitIds = await overLimitAccountIds(ws.id, svc);

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

  // "Connect → fill your queue" gate. A user who connects a channel HERE (in
  // settings, not the onboarding wizard) has a live place to post but an empty
  // queue and no nudge to generate it — the channel→draft cliff. Show a
  // prominent CTA at the top when at least one channel is actually CONNECTED
  // (not just connecting/errored) AND no posting_plan exists yet. The moment a
  // plan exists we drop the card. We scope to status='connected' (vs the list's
  // broader "not disconnected") so the CTA only fires once there's somewhere
  // real to publish.
  const hasConnectedChannel = (accounts ?? []).some((a) => a.status === "connected");
  const showFirstPlanCta = hasConnectedChannel && !hasPlan;
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
      : hasAny && hasBrief && !hasPlan && !showFirstPlanCta
        ? {
            // Reached only when a brief exists + no plan but no channel is
            // actually CONNECTED yet (e.g. a connect is mid-flight/errored).
            // When a channel IS connected, the top-of-page "fill your queue"
            // CTA supersedes this — same destination, stronger nudge — so we
            // don't stack two cards pointing at step=3.
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

      {/* Connect → fill your queue. Top-of-page CTA for users who connected a
          channel here in settings (outside the onboarding wizard) and have an
          empty queue — links straight to the existing plan generator. Hidden
          once any posting_plan exists. */}
      {showFirstPlanCta ? <FirstPlanCta /> : null}

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
            {accounts!.map((a) => {
              const isOverLimit = overLimitIds.has(a.id);
              return (
                <li
                  key={a.id}
                  className={`transition-colors duration-200 hover:bg-muted/30${
                    isOverLimit ? " bg-amber-500/5" : ""
                  }`}
                >
                  <Link
                    href={`/settings/channels/${a.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <ChannelBadge channel={a.channel} />
                      <span
                        className={`font-medium${isOverLimit ? " text-muted-foreground" : ""}`}
                      >
                        {/* displayHandle strips any leading @ then prefixes one —
                            YouTube stores "@name", which made a bare `@{handle}`
                            render "@@name". */}
                        {displayHandle(a.handle)}
                      </span>
                      {isOverLimit ? (
                        // Over the plan's connected-channel cap: stays connected but
                        // blocked from publishing + auto-actions until upgrade/disconnect.
                        <span className="text-xs text-muted-foreground">
                          Inactive — upgrade or disconnect
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {a.trust_mode
                            ? `auto-post (${a.successful_post_count}/${a.trust_threshold})`
                            : "manual approval"}
                        </span>
                      )}
                    </div>
                    {isOverLimit ? (
                      <Badge variant="warning">Inactive</Badge>
                    ) : (
                      <Badge variant={statusBadgeVariant(a.status)}>
                        {statusBadgeLabel(a.status)}
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
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
              {overLimitIds.size > 0 ? (
                // Over-limit (not just at-limit): some connected accounts are
                // beyond the cap and have been made inactive. Explain the soft
                // enforcement — they stay connected, but won't publish or take
                // auto-actions until the user upgrades or disconnects one.
                <>
                  <p className="font-medium">
                    {overLimitIds.size} {overLimitIds.size === 1 ? "channel is" : "channels are"}{" "}
                    over your {tier.name} plan limit.
                  </p>
                  <p className="text-muted-foreground">
                    Your {tier.name} plan includes {channelLimit}{" "}
                    {channelLimit === 1 ? "channel" : "channels"}, but {connectedCount} are
                    connected. The newest {overLimitIds.size}{" "}
                    {overLimitIds.size === 1 ? "is" : "are"} marked{" "}
                    <span className="font-medium">Inactive</span> — still connected, but
                    they won&apos;t publish or auto-engage. Upgrade to reactivate them, or
                    disconnect a channel to free a slot.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium">
                    Channel limit reached on the {tier.name} plan.
                  </p>
                  <p className="text-muted-foreground">
                    You&apos;re using {connectedCount} of {channelLimit} connected{" "}
                    {channelLimit === 1 ? "channel" : "channels"}. Upgrade to connect more.
                  </p>
                </>
              )}
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

      {(() => {
        // Only offer channels that aren't already connected AND whose OAuth env
        // is configured on this deployment. When every channel is connected the
        // section collapses to a quiet "all set" note.
        const available = CONNECTORS.filter(
          (c) => !connectedChannels.has(c.slug) && channelOauthConfigured(c.slug),
        );
        if (available.length === 0) {
          return (
            <section className="space-y-3">
              <h2 className="text-base font-medium">Add a channel</h2>
              <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
                Every supported channel is connected. Manage them in the list above.
              </p>
            </section>
          );
        }
        return (
          <section className="space-y-3">
            <h2 className="text-base font-medium">Add a channel</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {available.map((c) =>
                "comingSoon" in c && c.comingSoon ? (
              // Awaiting platform approval (LinkedIn CMA review / TikTok audit).
              // Disabled tile with a "Coming soon" badge — no connect attempt.
              <span
                key={c.slug}
                aria-disabled="true"
                title="Awaiting platform approval"
                className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-sm font-medium opacity-60 cursor-not-allowed"
              >
                <ChannelBadge channel={c.slug} />
                <span>{c.label.replace(/^Connect /, "")}</span>
                <span className="ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Coming soon
                </span>
              </span>
            ) : c.initiate ? (
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
        );
      })()}
    </div>
  );
}

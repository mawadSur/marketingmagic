import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { computeThemeStats, type ThemeStat, type ThemeVerdict } from "@/lib/analytics/themes";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

// Phase 6A — /analytics/themes
//
// Per-theme engagement distribution over a rolling 28-day window. Each
// theme is compared to the workspace baseline via a Beta-Binomial
// posterior (50-effective-sample prior centred on the workspace's own
// engagement rate). The verdict — winner / loser / inconclusive — is
// driven by whether the 80% credible interval excludes the baseline.
//
// Cold-start: themes need ≥3 posts each *and* the workspace needs ≥14
// days of metrics before the page surfaces anything. We show the empty
// state until both gates pass so we never paint a verdict on noise.

export default async function ThemesAnalyticsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const stats = await computeThemeStats(ws.id, 28);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Themes · 28-day rolling window</p>
        <h1 className="text-3xl font-semibold tracking-tight">Theme performance</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each theme&apos;s engagement rate is shrunk toward the workspace baseline (Bayesian
          Beta-Binomial, effective prior of 50 samples). Verdicts use the 80% credible
          interval — &quot;winner&quot; / &quot;loser&quot; only when the interval excludes baseline.
          Recent posts count more (30-day half-life) so the signal tracks the present.
        </p>
      </header>

      {stats.length === 0 ? (
        <EmptyState
          icon="chart"
          title="Not enough data yet."
          description="Need at least 14 days of posted-and-measured posts, with 3+ posts per theme, before we can compare theme performance honestly."
        />
      ) : (
        <ThemeTable stats={stats} />
      )}
    </div>
  );
}

function ThemeTable({ stats }: { stats: ThemeStat[] }) {
  const baseline = stats[0]?.baseline ?? 0;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Workspace baseline (28d):{" "}
          <span className="font-medium tabular-nums text-foreground">
            {(baseline * 100).toFixed(2)}%
          </span>{" "}
          engagement
        </p>
        <p className="text-xs text-muted-foreground">
          Possible reasons, never certainties.
        </p>
      </div>
      {/* Below md: a stacked card per theme (no horizontal scroll at 390px).
          At md: and up the full six-column table. Same columns either way. */}
      <div className="space-y-3 md:hidden">
        {stats.map((s) => (
          <ThemeCard key={s.tag} stat={s} />
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Theme</th>
              <th className="px-4 py-2.5 text-right font-medium">Posts</th>
              <th className="px-4 py-2.5 text-right font-medium">Posterior</th>
              <th className="px-4 py-2.5 text-right font-medium">80% CI</th>
              <th className="px-4 py-2.5 text-right font-medium">Lift</th>
              <th className="px-4 py-2.5 text-right font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {stats.map((s) => (
              <ThemeRow key={s.tag} stat={s} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-3xl text-xs text-muted-foreground">
        Lift is the posterior mean divided by the workspace baseline. CI bounds are
        80%, not 95% — the threshold favours surfacing directional signal over
        only-the-most-certain effects. Themes with fewer than 3 posts are hidden.
      </p>
    </section>
  );
}

function ThemeRow({ stat }: { stat: ThemeStat }) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return (
    <tr className="transition-colors duration-200 hover:bg-muted/30">
      <td className="px-4 py-3 font-medium">
        <span className="truncate">#{stat.tag}</span>
        <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
          {pct(stat.observed_rate)} observed
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {stat.posts}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{pct(stat.posterior_mean)}</td>
      <td className="px-4 py-3 text-right text-xs tabular-nums text-muted-foreground">
        {pct(stat.ci_low)} – {pct(stat.ci_high)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span
          className={
            stat.verdict === "winner"
              ? "font-medium text-success"
              : stat.verdict === "loser"
                ? "font-medium text-warning"
                : "text-muted-foreground"
          }
        >
          {stat.lift.toFixed(2)}×
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <VerdictBadge verdict={stat.verdict} />
      </td>
    </tr>
  );
}

// Stacked card used below md: theme name + verdict on top, then a small
// stat grid carrying every column the table has (observed, posts, posterior,
// 80% CI, lift) so nothing is dropped on narrow screens.
function ThemeCard({ stat }: { stat: ThemeStat }) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const liftClass =
    stat.verdict === "winner"
      ? "font-medium text-success"
      : stat.verdict === "loser"
        ? "font-medium text-warning"
        : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">#{stat.tag}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {pct(stat.observed_rate)} observed
          </p>
        </div>
        <VerdictBadge verdict={stat.verdict} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-muted-foreground">Posts</dt>
          <dd className="tabular-nums">{stat.posts}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-muted-foreground">Posterior</dt>
          <dd className="tabular-nums">{pct(stat.posterior_mean)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-muted-foreground">Lift</dt>
          <dd className={`tabular-nums ${liftClass}`}>{stat.lift.toFixed(2)}×</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-muted-foreground">80% CI</dt>
          <dd className="text-xs tabular-nums text-muted-foreground">
            {pct(stat.ci_low)} – {pct(stat.ci_high)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: ThemeVerdict }) {
  if (verdict === "winner") {
    return (
      <Badge variant="success" title="80% CI excludes baseline on the upside">
        Likely winner
      </Badge>
    );
  }
  if (verdict === "loser") {
    return (
      <Badge variant="warning" title="80% CI excludes baseline on the downside">
        Likely loser
      </Badge>
    );
  }
  return (
    <Badge variant="muted" title="80% CI overlaps baseline — not enough signal">
      Inconclusive
    </Badge>
  );
}

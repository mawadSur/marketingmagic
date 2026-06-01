import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { loadThemeWinners } from "@/lib/analytics/themes";

// Bet ① — surface the learning loop. This is the product's moat made visible:
// we don't just post, we measure every post and figure out which THEMES
// genuinely beat the workspace's own baseline (Bayesian shrinkage, not raw
// averages — see lib/analytics/themes.ts), then the next generated plan leans
// into the winners. The dashboard's "Themes leaderboard" shows raw averages;
// THIS shows the statistically-confident winners + the loop framing.
//
// Cold-start: hides entirely when there are no confident winners yet (matches
// the dashboard's "no empty cards" convention) so it only appears once the
// learning loop has real signal.
export async function WinningThemesWidget({ workspaceId }: { workspaceId: string }) {
  const winners = await loadThemeWinners(workspaceId, 5);
  if (winners.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div className="space-y-0.5">
          <p className="label-eyebrow">What&apos;s working</p>
          <h2 className="text-base font-medium">Your winning themes</h2>
        </div>
        <Link
          href="/analytics/themes"
          className="text-xs text-primary underline-offset-4 transition-colors duration-200 hover:underline"
        >
          See the analysis →
        </Link>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <TrendingUp className="h-4 w-4" aria-hidden />
          </span>
          <p className="text-muted-foreground">
            These themes beat your baseline with confidence. Your next plan leans into them
            automatically.
          </p>
        </div>
        <ul className="divide-y">
          {winners.map((w) => (
            <li
              key={w.tag}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">#{w.tag}</span>
                <span className="text-xs text-muted-foreground">
                  {w.posts} post{w.posts === 1 ? "" : "s"}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                <TrendingUp className="h-3 w-3" aria-hidden />
                {w.lift.toFixed(1)}× baseline
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

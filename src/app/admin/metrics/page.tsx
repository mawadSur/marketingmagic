import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getAuthedUserOrRedirect } from "@/lib/workspace";
import { isOperator } from "@/lib/admin/operator";
import { supabaseService } from "@/lib/supabase/service";
import { computeNorthStar, type NorthStar } from "@/lib/metrics/north-star";

export const metadata: Metadata = { title: "North Star — admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

function pct(frac: number | null): string {
  return frac == null ? "—" : `${(frac * 100).toFixed(1)}%`;
}
function dur(ms: number | null): string {
  if (ms == null) return "—";
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default async function AdminMetricsPage() {
  // Founder/staff only. getAuthedUserOrRedirect bounces anonymous users to
  // /login; everyone else who isn't on the ADMIN_EMAILS allowlist gets a 404 so
  // the page's existence isn't even disclosed to customers.
  const user = await getAuthedUserOrRedirect();
  if (!isOperator(user.email)) notFound();

  let data: NorthStar | null = null;
  let error: string | null = null;
  try {
    data = await computeNorthStar(supabaseService());
  } catch (e) {
    error = e instanceof Error ? e.message : "failed to compute metrics";
  }

  return (
    <main className="container max-w-3xl py-12">
      <header className="mb-8 space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Founder dashboard · internal
        </p>
        <h1 className="text-3xl font-bold tracking-tight">North Star</h1>
        {data ? (
          <p className="text-sm text-muted-foreground">
            Weekly Active Publishing Workspaces · as of{" "}
            {new Date(data.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
          </p>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          Couldn&apos;t compute metrics: {error}
        </div>
      ) : data ? (
        <div className="space-y-8">
          {/* Hero metric */}
          <section className="rounded-2xl border bg-muted/10 p-6">
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-bold tabular-nums">{data.wapw}</span>
              <span className="text-sm text-muted-foreground">
                workspaces published in the last 7 days
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{data.read}</p>
          </section>

          {/* Activation funnel */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activation funnel
            </h2>
            <div className="space-y-2">
              {data.funnel.map((s, i) => {
                const frac = s.base ? s.count / s.base : 0;
                const isStar = s.label.startsWith("Published");
                return (
                  <div key={s.label} className="flex items-center gap-3">
                    <div className="w-40 shrink-0 text-sm">{s.label}</div>
                    <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-muted/40">
                      <div
                        className={"h-full rounded-md " + (isStar ? "bg-primary" : "bg-primary/40")}
                        style={{ width: `${Math.max(frac * 100, 2)}%` }}
                        aria-hidden
                      />
                    </div>
                    <div className="w-28 shrink-0 text-right text-sm tabular-nums">
                      <span className="font-medium">{s.count}</span>{" "}
                      <span className="text-muted-foreground">{i === 0 ? "" : pct(frac)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Quality */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activation quality
            </h2>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Activation (of workspaces)" value={pct(data.activationByWorkspace)} />
              <Stat label="Activation (of signups)" value={pct(data.activationBySignup)} />
              <Stat label="TTFP median" value={dur(data.ttfp.medianMs)} />
              <Stat label="TTFP fastest" value={dur(data.ttfp.minMs)} />
              <Stat label="TTFP slowest" value={dur(data.ttfp.maxMs)} />
              <Stat
                label="W4 retention"
                value={
                  data.w4.eligible
                    ? `${pct(data.w4.retained / data.w4.eligible)} (${data.w4.retained}/${data.w4.eligible})`
                    : "—"
                }
              />
            </dl>
          </section>

          {/* Trend */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              WAPW · last 8 weeks
            </h2>
            <div className="flex items-end gap-2" aria-hidden>
              {data.trend.map((t) => {
                const max = Math.max(1, ...data!.trend.map((x) => x.count));
                return (
                  <div key={t.label} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex h-24 w-full items-end">
                      <div
                        className="w-full rounded-t bg-primary/70"
                        style={{ height: `${Math.max((t.count / max) * 100, 3)}%` }}
                      />
                    </div>
                    <span className="text-[10px] tabular-nums text-muted-foreground">{t.count}</span>
                    <span className="text-[10px] text-muted-foreground">{t.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="sr-only">
              Weekly active publishing workspaces by week:{" "}
              {data.trend.map((t) => `${t.label}: ${t.count}`).join(", ")}.
            </p>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/10 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

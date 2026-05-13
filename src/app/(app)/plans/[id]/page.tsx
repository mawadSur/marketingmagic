import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const [planRes, postsRes] = await Promise.all([
    supabase
      .from("posting_plans")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", ws.id)
      .maybeSingle(),
    supabase
      .from("posts")
      .select("id, text, theme, scheduled_at, status, channel")
      .eq("plan_id", id)
      .eq("workspace_id", ws.id)
      .order("scheduled_at", { ascending: true }),
  ]);

  if (!planRes.data) notFound();
  const plan = planRes.data;
  const posts = postsRes.data ?? [];

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          href="/plans"
          className="inline-flex items-center text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          ← All plans
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="label-eyebrow">Plan</p>
            <h1 className="text-3xl font-semibold tracking-tight">{plan.name}</h1>
          </div>
          <Badge variant={statusBadgeVariant(plan.status)}>{statusBadgeLabel(plan.status)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="tabular-nums">
            {plan.start_at.slice(0, 10)} → {plan.end_at.slice(0, 10)}
          </span>
          {" · "}
          {posts.length} {posts.length === 1 ? "post" : "posts"}
          {" · "}
          <Link
            href="/queue"
            className="text-primary underline-offset-4 transition-colors duration-200 hover:underline"
          >
            review in queue →
          </Link>
        </p>
        {plan.generation_prompt ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed">
            {plan.generation_prompt}
          </p>
        ) : null}
      </header>

      {posts.length === 0 ? (
        <EmptyState
          icon="doc"
          title="This plan has no posts."
          description="That's unusual — generation may have failed mid-flight. Try regenerating from /plans/new."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {posts.map((p) => (
            <li
              key={p.id}
              className="space-y-1.5 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <ChannelBadge channel={p.channel} />
                  {p.theme ? <span>#{p.theme}</span> : null}
                  <span className="tabular-nums">{p.scheduled_at?.slice(0, 16).replace("T", " ")}</span>
                </div>
                <Badge variant={statusBadgeVariant(p.status)}>{statusBadgeLabel(p.status)}</Badge>
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{p.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

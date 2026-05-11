import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";

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
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">{plan.name}</h1>
          <span className="rounded-md border px-2 py-0.5 text-xs uppercase tracking-wide">
            {plan.status}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {plan.start_at.slice(0, 10)} → {plan.end_at.slice(0, 10)} ·{" "}
          {posts.length} posts ·{" "}
          <Link href="/queue" className="text-primary underline-offset-4 hover:underline">
            review in queue →
          </Link>
        </p>
        {plan.generation_prompt ? (
          <p className="rounded-md border bg-muted/50 p-3 text-sm">{plan.generation_prompt}</p>
        ) : null}
      </header>

      <ul className="divide-y rounded-lg border">
        {posts.map((p) => (
          <li key={p.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {p.theme ? `#${p.theme}` : ""} · {p.scheduled_at?.slice(0, 16).replace("T", " ")}
              </span>
              <span className="rounded-md border px-2 py-0.5 text-[10px] uppercase">{p.status}</span>
            </div>
            <p className="whitespace-pre-wrap">{p.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

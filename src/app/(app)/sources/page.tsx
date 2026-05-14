import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

// /sources — list every source the workspace has ingested. Source detail
// (cluster generation) lives at /sources/[id]; the "Add new" CTA links to
// /sources/new. Workspaces with no sources get the cold-start empty state.
export default async function SourcesPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Aggregate count of posts per source via a single query — limits the
  // round-trip while still showing the user how many drafts each source
  // produced. Falls back to 0 on rows where the foreign key never had any
  // posts attached.
  const [sourcesRes, postCountsRes] = await Promise.all([
    supabase
      .from("sources")
      .select("id, source_kind, source_url, title, extracted_summary, ingested_at")
      .eq("workspace_id", ws.id)
      .order("ingested_at", { ascending: false })
      .limit(50),
    supabase
      .from("posts")
      .select("source_id")
      .eq("workspace_id", ws.id)
      .not("source_id", "is", null),
  ]);

  const sources = sourcesRes.data ?? [];
  const postCounts = new Map<string, number>();
  for (const row of postCountsRes.data ?? []) {
    if (row.source_id) {
      postCounts.set(row.source_id, (postCounts.get(row.source_id) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Sources</p>
          <h1 className="text-3xl font-semibold tracking-tight">Source library</h1>
          <p className="text-sm text-muted-foreground">
            Paste a URL or a transcript. We extract themes, quotes, and facts, then generate a
            content cluster anchored to that source.
          </p>
        </div>
        <Link
          href="/sources/new"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          Add a source
        </Link>
      </header>

      {sources.length === 0 ? (
        <EmptyState
          icon="doc"
          title="No sources yet."
          description="Paste a blog post URL, a transcript, or a meeting summary. We'll pull the load-bearing themes and turn them into a posting plan."
          action={
            <Link
              href="/sources/new"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Add your first source
            </Link>
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {sources.map((s) => {
            const postCount = postCounts.get(s.id) ?? 0;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-2 px-4 py-4 transition-colors duration-200 hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`/sources/${s.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {s.title ?? "Untitled source"}
                  </Link>
                  {s.extracted_summary ? (
                    <p className="line-clamp-2 max-w-2xl text-sm text-muted-foreground">
                      {s.extracted_summary}
                    </p>
                  ) : null}
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="muted">{kindLabel(s.source_kind)}</Badge>
                    {s.source_url ? (
                      <a
                        href={s.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="max-w-xs truncate underline-offset-4 hover:underline"
                      >
                        {prettyUrl(s.source_url)}
                      </a>
                    ) : null}
                    <span className="tabular-nums">
                      {new Date(s.ingested_at).toISOString().slice(0, 10)}
                    </span>
                    <span>· {postCount} post{postCount === 1 ? "" : "s"}</span>
                  </p>
                </div>
                <Link
                  href={`/sources/${s.id}`}
                  className="shrink-0 text-sm text-primary underline-offset-4 transition-colors duration-200 hover:underline"
                >
                  Open →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "html":
      return "Article";
    case "youtube":
      return "YouTube";
    case "podcast":
      return "Podcast";
    case "pdf":
      return "PDF";
    case "transcript":
      return "Transcript";
    default:
      return kind;
  }
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

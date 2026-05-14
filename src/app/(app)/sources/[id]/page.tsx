import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExtractedQuote, ExtractedFact } from "@/lib/db/types";
import { GenerateClusterButton } from "./generate-cluster-button";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SourceDetailPage({ params }: PageProps) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const { data: source } = await supabase
    .from("sources")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!source) notFound();

  // Posts already generated from this source — surfaced as a "Generated posts"
  // list so the user can audit what cluster output looked like. We include
  // pending/scheduled/posted; rejected/failed are excluded to keep the
  // signal-to-noise high.
  const { data: generatedPosts } = await supabase
    .from("posts")
    .select("id, text, theme, channel, status, scheduled_at, idea_id, voice_score, low_confidence")
    .eq("workspace_id", ws.id)
    .eq("source_id", id)
    .in("status", ["pending_approval", "scheduled", "posted", "approved"])
    .order("scheduled_at", { ascending: true })
    .limit(50);

  const themes = asStringArray(source.extracted_themes);
  const quotes = asQuotes(source.extracted_quotes);
  const facts = asFacts(source.extracted_facts);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/sources"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            ← All sources
          </Link>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{kindLabel(source.source_kind)}</Badge>
            {source.source_url ? (
              <a
                href={source.source_url}
                target="_blank"
                rel="noreferrer"
                className="max-w-md truncate text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                {source.source_url}
              </a>
            ) : null}
            <span className="text-xs text-muted-foreground tabular-nums">
              ingested {new Date(source.ingested_at).toISOString().slice(0, 10)}
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {source.title ?? "Untitled source"}
          </h1>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          {source.extracted_summary ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{source.extracted_summary}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">No summary extracted.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Themes</CardTitle>
          </CardHeader>
          <CardContent>
            {themes.length === 0 ? (
              <p className="text-sm italic text-muted-foreground">No themes extracted.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {themes.map((t) => (
                  <li key={t}>
                    <Badge variant="default">#{t}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quotes</CardTitle>
          </CardHeader>
          <CardContent>
            {quotes.length === 0 ? (
              <p className="text-sm italic text-muted-foreground">No quotes extracted.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {quotes.map((q, i) => (
                  <li key={i} className="border-l-2 border-muted pl-3">
                    <p className="italic">&ldquo;{q.text}&rdquo;</p>
                    {q.speaker ? (
                      <p className="mt-1 text-xs text-muted-foreground">— {q.speaker}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Facts</CardTitle>
          </CardHeader>
          <CardContent>
            {facts.length === 0 ? (
              <p className="text-sm italic text-muted-foreground">No facts extracted.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {facts.map((f, i) => (
                  <li key={i}>
                    <p>{f.text}</p>
                    {f.context ? (
                      <p className="text-xs text-muted-foreground">{f.context}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <p className="label-eyebrow">Generate</p>
            <h2 className="text-base font-medium">Turn this into a content cluster</h2>
            <p className="text-sm text-muted-foreground">
              Claude will produce a one-week cluster across your connected channels, anchored to
              the themes and quotes above. Drafts land in the queue.
            </p>
          </div>
          <GenerateClusterButton sourceId={source.id} />
        </div>
      </section>

      {generatedPosts && generatedPosts.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-eyebrow">Generated</p>
              <h2 className="text-base font-medium">
                {generatedPosts.length} post{generatedPosts.length === 1 ? "" : "s"} from this source
              </h2>
            </div>
            <Link
              href="/queue"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Open queue →
            </Link>
          </div>
          <ul className="divide-y rounded-lg border bg-card">
            {generatedPosts.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/30"
              >
                <div className="min-w-0 space-y-1">
                  <p className="line-clamp-2 font-medium">{p.text}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ChannelBadge channel={p.channel} />
                    {p.theme ? <span>#{p.theme}</span> : null}
                    {p.scheduled_at ? (
                      <span className="tabular-nums">
                        {p.scheduled_at.slice(0, 16).replace("T", " ")}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Badge variant={statusBadgeVariant(p.status)} className="shrink-0">
                  {statusBadgeLabel(p.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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

// Tolerant narrowing helpers — mirror the ones in
// src/lib/sources/generate-from-source.ts (intentionally duplicated; the
// page is a server component so importing from a use-server module is fine
// but the narrowing here doesn't need the planner-tied shape).
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  return out;
}
function asQuotes(value: unknown): ExtractedQuote[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedQuote[] = [];
  for (const v of value) {
    if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") {
      const obj = v as { text: string; speaker?: unknown };
      const q: ExtractedQuote = { text: obj.text };
      if (typeof obj.speaker === "string" && obj.speaker.length > 0) q.speaker = obj.speaker;
      out.push(q);
    }
  }
  return out;
}
function asFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedFact[] = [];
  for (const v of value) {
    if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") {
      const obj = v as { text: string; context?: unknown };
      const f: ExtractedFact = { text: obj.text };
      if (typeof obj.context === "string" && obj.context.length > 0) f.context = obj.context;
      out.push(f);
    }
  }
  return out;
}

// Video hook analysis page (Hormozi slice 2, v1) — thin UI.
//
// Lists this workspace's posts that carry a rendered video and offers an
// "Analyze hook" button per post → a direct-response breakdown (spoken +
// visual hooks, first-5s, pattern interrupts, on-screen text). BYO-key +
// user-chosen model — no central cost.
//
// SCOPE (v1): our-rendered videos only (bytes we own in post-media-video).
// Organic videos posted outside our pipeline are deferred (see run.ts TODO).
// STUBBED: no list of past analyses, no re-run history — the button shows the
// latest pass inline (analyze-hook-form.tsx).

import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { byoKeysConfigured } from "@/lib/env";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import type { Json } from "@/lib/db/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AnalyzeHookForm } from "./analyze-hook-form";

export const dynamic = "force-dynamic";

// True when the post's media jsonb carries at least one rendered video item.
function hasRenderedVideo(media: Json): boolean {
  if (!Array.isArray(media)) return false;
  return media.some(
    (m) =>
      m &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      (m as Record<string, unknown>).kind === "video" &&
      typeof (m as Record<string, unknown>).storage_path === "string",
  );
}

export default async function AnalyzeVideoPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  if (!byoKeysConfigured()) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header />
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Hook analysis isn&apos;t available on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            Credential encryption isn&apos;t configured (set <code>BYO_ENCRYPTION_KEY</code>).
          </p>
        </div>
      </div>
    );
  }

  const status = await getWorkspaceKeyStatus(ws.id);

  // Posts (user-scoped client → RLS governs) that might carry a rendered video.
  // We over-fetch a recent window and filter on the media jsonb in JS, since the
  // jsonb-array membership test is awkward to express portably here.
  const supabase = await supabaseServer();
  const { data: rows } = await supabase
    .from("posts")
    .select("id, text, channel, status, media, created_at")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: false })
    .limit(100);

  const videoPosts = (rows ?? []).filter((p) => hasRenderedVideo(p.media));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Header />

      {!status.analysis ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">No analysis key set.</p>
          <p className="mt-1 text-muted-foreground">
            Add your analysis provider key + model (Gemini recommended) in{" "}
            <Link className="underline underline-offset-4" href="/settings/video-keys">
              Video keys
            </Link>{" "}
            to enable hook analysis.
          </p>
        </div>
      ) : null}

      {videoPosts.length === 0 ? (
        <EmptyState
          title="No rendered videos yet"
          description="Render a video first — then analyze its hook here. v1 supports videos rendered in this app (organic clips posted elsewhere are coming later)."
        />
      ) : (
        videoPosts.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <CardTitle className="text-base">
                {p.text?.trim() ? truncate(p.text, 80) : "Untitled video post"}
              </CardTitle>
              <CardDescription>
                {p.channel} · {p.status}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AnalyzeHookForm postId={p.id} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Hook analysis</h1>
      <p className="text-sm text-muted-foreground">
        Break down a short-form video&apos;s hook — spoken + visual, first 5 seconds, pattern
        interrupts, and on-screen text. Bring your own analysis key and model.
      </p>
    </header>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { postPublicUrl } from "@/lib/social/post-url";
import type { Json } from "@/lib/db/types";

export const dynamic = "force-dynamic";

// Video library — watch every finished render and see WHERE it's been deployed.
//
// A finished render is a video_jobs row with status='ready' + storage_path (the
// mp4 in the public `post-media-video` bucket). "Deployed" = the post the render
// was attached to (post_id): a draft awaiting approval, a scheduled post, or a
// published one (status='posted' → live on the channel, with a "View live" link
// built from external_id). Renders with no destination ("Save to library") show
// as library-only.
//
// We read jobs through the user-scoped client (workspace RLS is the source of
// truth) but mint public URLs with the service client's getPublicUrl (a pure
// string builder for a public bucket — no privileged read).

function paramString(params: Json | null, key: string, fallback: string): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return fallback;
}

interface ReadyRender {
  id: string;
  subject: string;
  aspect: string;
  isUgc: boolean;
  createdAt: string;
  videoUrl: string;
  // Deployment (the attached post), null when "saved to library" only.
  post: {
    id: string;
    status: string;
    channel: string;
    handle: string | null;
    scheduledAt: string | null;
    postedAt: string | null;
    liveUrl: string | null;
  } | null;
}

export default async function VideoLibraryPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Ready renders, newest first. RLS scopes to the workspace.
  const { data: jobRows } = await supabase
    .from("video_jobs")
    .select("id, status, params, storage_path, post_id, created_at")
    .eq("workspace_id", ws.id)
    .eq("status", "ready")
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(60);

  const rows = jobRows ?? [];

  // Resolve the attached posts (deployment state) in one trip.
  const postIds = rows.map((r) => r.post_id).filter((id): id is string => Boolean(id));
  const postById = new Map<
    string,
    { status: string; channel: string; social_account_id: string; external_id: string | null; scheduled_at: string | null; posted_at: string | null }
  >();
  if (postIds.length > 0) {
    const { data: posts } = await supabase
      .from("posts")
      .select("id, status, channel, social_account_id, external_id, scheduled_at, posted_at")
      .in("id", postIds);
    for (const p of posts ?? []) postById.set(p.id, p);
  }

  // Handles for "View live" URL building, keyed by social_account_id.
  const acctIds = [...postById.values()].map((p) => p.social_account_id).filter(Boolean);
  const handleByAcct = new Map<string, string>();
  if (acctIds.length > 0) {
    const { data: accts } = await supabase
      .from("social_accounts_safe")
      .select("id, handle")
      .in("id", acctIds);
    for (const a of accts ?? []) handleByAcct.set(a.id, a.handle);
  }

  const svc = supabaseService();
  const renders: ReadyRender[] = rows.map((r) => {
    const { data: pub } = svc.storage.from("post-media-video").getPublicUrl(r.storage_path as string);
    const post = r.post_id ? postById.get(r.post_id) : undefined;
    const handle = post ? handleByAcct.get(post.social_account_id) ?? null : null;
    return {
      id: r.id,
      subject: paramString(r.params, "video_subject", "Untitled video"),
      aspect: paramString(r.params, "video_aspect", "9:16"),
      isUgc: paramString(r.params, "kind", "") === "reference_image",
      createdAt: r.created_at,
      videoUrl: pub.publicUrl,
      post: post
        ? {
            id: r.post_id as string,
            status: post.status,
            channel: post.channel,
            handle,
            scheduledAt: post.scheduled_at,
            postedAt: post.posted_at,
            liveUrl:
              post.status === "posted"
                ? postPublicUrl(post.channel, post.external_id, handle)
                : null,
          }
        : null,
    };
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="label-eyebrow">Video</p>
          <h1 className="text-3xl font-semibold tracking-tight">Video library</h1>
          <p className="text-sm text-muted-foreground">
            Every finished render — watch it here and see where it&apos;s been deployed.
          </p>
        </div>
        <Link
          href="/video"
          className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground"
        >
          ← Generate a video
        </Link>
      </header>

      {renders.length === 0 ? (
        <EmptyState
          icon="spark"
          title="No finished videos yet."
          description="Generate one from /video — it'll appear here the moment the render completes, ready to watch and publish."
        />
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {renders.map((r) => (
            <li key={r.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
              {/* Player. Vertical renders get a portrait frame; others fill width. */}
              <div className="flex justify-center bg-black">
                <video
                  src={r.videoUrl}
                  controls
                  preload="metadata"
                  playsInline
                  className={
                    r.aspect === "9:16"
                      ? "max-h-[28rem] w-auto"
                      : "h-auto w-full"
                  }
                />
              </div>

              <div className="flex flex-1 flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium" title={r.subject}>
                    {r.subject}
                  </p>
                  {r.isUgc ? (
                    <Badge variant="muted" className="shrink-0">
                      UGC
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {r.aspect} · {new Date(r.createdAt).toLocaleDateString()}
                </p>

                {/* Deployment status — where this render lives now. */}
                <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                  {r.post ? (
                    <>
                      <ChannelBadge channel={r.post.channel} />
                      <Badge variant={statusBadgeVariant(r.post.status)}>
                        {statusBadgeLabel(r.post.status)}
                      </Badge>
                      {r.post.status === "posted" ? (
                        r.post.liveUrl ? (
                          <a
                            href={r.post.liveUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            View live →
                          </a>
                        ) : (
                          <span className="text-muted-foreground">Published</span>
                        )
                      ) : (
                        <Link
                          href="/queue"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {r.post.status === "scheduled" ? "View in queue →" : "Review in queue →"}
                        </Link>
                      )}
                    </>
                  ) : (
                    <>
                      <Badge variant="muted">Library only</Badge>
                      <span className="text-muted-foreground">Not attached to a post.</span>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

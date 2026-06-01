import { supabaseService } from "@/lib/supabase/service";
import { currentMonthBucket } from "@/lib/billing/tiers";

// Best-effort upsert into usage_counters for the current YYYY-MM bucket.
// We always go through service role — RLS forbids client writes here so
// users can't game their own quota.
//
// On conflict we add `n` to the existing count. We can't use Supabase's
// PostgREST onConflict semantics for an additive update, so we do a
// read-then-write with no transaction. Two concurrent requests in the
// same millisecond can clobber each other by `n` — acceptable for a
// quota counter where the worst case is one free post per race.

type UsageColumn = "posts_generated" | "images_generated" | "videos_generated";

async function bumpCounter(workspaceId: string, column: UsageColumn, n: number) {
  if (n <= 0) return;
  const svc = supabaseService();
  const month = currentMonthBucket();

  const { data: existing } = await svc
    .from("usage_counters")
    .select("posts_generated, images_generated, videos_generated")
    .eq("workspace_id", workspaceId)
    .eq("month", month)
    .maybeSingle();

  if (existing) {
    const current = (existing[column] as number | null) ?? 0;
    const next = current + n;
    const patch: Partial<Record<UsageColumn, number>> = { [column]: next };
    await svc
      .from("usage_counters")
      .update(patch)
      .eq("workspace_id", workspaceId)
      .eq("month", month);
    return;
  }

  await svc.from("usage_counters").insert({
    workspace_id: workspaceId,
    month,
    posts_generated: column === "posts_generated" ? n : 0,
    images_generated: column === "images_generated" ? n : 0,
    videos_generated: column === "videos_generated" ? n : 0,
  });
}

export async function incrementPostsGenerated(workspaceId: string, n: number): Promise<void> {
  await bumpCounter(workspaceId, "posts_generated", n);
}

export async function incrementImagesGenerated(workspaceId: string, n: number): Promise<void> {
  await bumpCounter(workspaceId, "images_generated", n);
}

// P4: bump the monthly video-render counter. Called from the orchestrator
// AFTER MPT accepts a render (so a transport failure isn't metered).
export async function incrementVideosGenerated(workspaceId: string, n: number): Promise<void> {
  await bumpCounter(workspaceId, "videos_generated", n);
}

export interface UsageSnapshot {
  month: string;
  postsGenerated: number;
  imagesGenerated: number;
  videosGenerated: number;
}

export async function getUsageSnapshot(workspaceId: string): Promise<UsageSnapshot> {
  const svc = supabaseService();
  const month = currentMonthBucket();
  const { data } = await svc
    .from("usage_counters")
    .select("posts_generated, images_generated, videos_generated")
    .eq("workspace_id", workspaceId)
    .eq("month", month)
    .maybeSingle();
  return {
    month,
    postsGenerated: data?.posts_generated ?? 0,
    imagesGenerated: data?.images_generated ?? 0,
    videosGenerated: data?.videos_generated ?? 0,
  };
}

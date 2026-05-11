import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";

export async function TrustNudge({ workspaceId }: { workspaceId: string }) {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts_safe")
    .select("id, handle, channel, trust_threshold, successful_post_count, trust_mode")
    .eq("workspace_id", workspaceId)
    .eq("status", "connected");

  const eligible = (data ?? []).find(
    (a) => !a.trust_mode && a.successful_post_count >= a.trust_threshold,
  );
  if (!eligible) return null;

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
      <p className="font-medium text-emerald-700">
        @{eligible.handle} hit {eligible.trust_threshold} successful posts.
      </p>
      <p className="text-muted-foreground">
        Turn on auto-scheduling? New drafts skip the queue with a 24h preview window.{" "}
        <Link
          href={`/settings/channels/${eligible.id}`}
          className="font-medium text-emerald-700 underline-offset-4 hover:underline"
        >
          Review trust settings →
        </Link>
      </p>
    </div>
  );
}

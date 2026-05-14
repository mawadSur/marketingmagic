import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import type { VoiceProfileDiff } from "@/lib/db/types";
import { BriefForm } from "./brief-form";
import { PendingVoiceDiffCard } from "./pending-voice-diff-card";
import { TimezoneSection } from "./timezone-section";

export const dynamic = "force-dynamic";

export default async function BriefPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("*")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  const pendingDiff = (brief?.pending_voice_diff ?? null) as VoiceProfileDiff | null;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">Brand brief</h1>
        <p className="text-sm text-muted-foreground">
          The brief feeds every generated post. Keep it sharp — vague briefs produce vague posts.
        </p>
      </header>
      {pendingDiff ? (
        <PendingVoiceDiffCard
          diff={pendingDiff}
          proposedAt={brief?.pending_voice_diff_at ?? null}
        />
      ) : null}
      {brief ? <TimezoneSection initial={brief.audience_timezone ?? null} /> : null}
      <BriefForm initial={brief ?? null} />
    </div>
  );
}

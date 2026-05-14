import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import type { VoiceProfileDiff } from "@/lib/db/types";
import { BriefForm } from "./brief-form";
import { PendingVoiceDiffCard } from "./pending-voice-diff-card";
import { TimezoneSection } from "./timezone-section";
import { ThemeSnoozeControls } from "./theme-snooze-controls";
import { getThemePreferences } from "@/lib/themes/preferences";

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
  const prefs = await getThemePreferences(ws.id);
  const knownThemes = await loadKnownThemes(ws.id);

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
      {brief ? (
        <ThemeSnoozeControls
          gapsEnabled={prefs.gapsEnabled}
          entries={prefs.entries.map((e) => ({
            theme: e.theme,
            snoozed_until: e.snoozed_until,
            archived: e.archived,
          }))}
          knownThemes={knownThemes}
        />
      ) : null}
      <BriefForm initial={brief ?? null} />
    </div>
  );
}

// Pulls the distinct list of themes the workspace has actually used on
// shipped posts. We feed this into the snooze controls so the user can
// pre-emptively mute a theme they don't want surfaced. Lower-cased + deduped
// for a stable presentation; capped at 50 to keep the dropdown sane.
async function loadKnownThemes(workspaceId: string): Promise<string[]> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("posts")
    .select("theme")
    .eq("workspace_id", workspaceId)
    .not("theme", "is", null)
    .limit(500);
  const set = new Set<string>();
  for (const row of data ?? []) {
    const t = (row as { theme: string | null }).theme;
    if (!t) continue;
    const key = t.trim().toLowerCase();
    if (key) set.add(key);
  }
  return Array.from(set).sort().slice(0, 50);
}

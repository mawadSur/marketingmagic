import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { TIERS, tierFor, hasFounderMode } from "@/lib/billing/tiers";
import { transcriptionConfigured } from "@/lib/sources/transcribe";
import { RecordClient } from "./record-client";

export const dynamic = "force-dynamic";

// Phase 2.6 Founder Mode. Voice-first capture surface. Tier-gated to
// founder plans — lower tiers get an upgrade CTA, not the recorder. The
// page is intentionally lean (auth → tier check → render the client) so
// the mobile-first surface in record-client.tsx stays the dominant
// rendered element.
export default async function RecordPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  // Service-role read because the active-workspace cookie path doesn't
  // include billing columns by default. Same pattern /settings/billing
  // uses.
  const svc = supabaseService();
  const { data: wsRow } = await svc
    .from("workspaces")
    .select("plan")
    .eq("id", ws.id)
    .maybeSingle();

  const plan = wsRow?.plan ?? "hobby";
  const tier = tierFor(plan);
  const founder = hasFounderMode(plan);

  if (!founder) {
    return (
      <div className="mx-auto max-w-xl space-y-6 py-8">
        <header className="space-y-2">
          <p className="label-eyebrow">Founder Mode</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Record a voice memo. Get a week of posts.
          </h1>
          <p className="text-sm text-muted-foreground">
            Voice-first capture is a {TIERS.founder.name}-tier feature. You're on the{" "}
            <span className="font-medium">{tier.name}</span> plan.
          </p>
        </header>

        <section className="rounded-lg border bg-card p-4 text-sm">
          <p className="mb-3">
            {TIERS.founder.name} tier unlocks:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Record a voice memo from your phone, anywhere.</li>
            <li>We transcribe + draft a week of posts in your voice.</li>
            <li>No typing required for the entire flow.</li>
          </ul>
        </section>

        <Link
          href="/settings/billing"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Upgrade to {TIERS.founder.name}
        </Link>
      </div>
    );
  }

  // Pull retention preference so the client knows whether to surface the
  // "audio will be saved" label vs the "audio is discarded after
  // transcription" label.
  const { data: brief } = await svc
    .from("brand_briefs")
    .select("audio_retention_opt_in")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  return (
    <RecordClient
      keepRawAudio={Boolean(brief?.audio_retention_opt_in)}
      transcriptionConfigured={transcriptionConfigured()}
    />
  );
}

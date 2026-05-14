"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { VoiceProfile } from "@/lib/db/types";
import { extractVoiceProfileAction } from "./actions";

interface Props {
  initialProfile: VoiceProfile | null;
  initialExtractedAt: string | null;
  // Posts count is sourced from the FORM state, not the saved brief, so the
  // button reflects what the user just typed (after save the page reloads
  // and this updates). Disabled until ≥3.
  referencePostsCount: number;
}

export function ExtractVoiceButton({
  initialProfile,
  initialExtractedAt,
  referencePostsCount,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<VoiceProfile | null>(initialProfile);
  const [extractedAt, setExtractedAt] = useState<string | null>(initialExtractedAt);

  const enough = referencePostsCount >= 3;
  const hasProfile = profile !== null;

  function run() {
    setError(null);
    start(async () => {
      const result = await extractVoiceProfileAction();
      if (result.error || !result.profile) {
        setError(result.error ?? "Extraction failed.");
        return;
      }
      setProfile(result.profile);
      setExtractedAt(result.profile.extracted_at);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-foreground text-[10px] font-bold text-background">
            AI
          </span>
          <span className="text-sm font-medium">Voice profile</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || !enough}
          onClick={run}
        >
          {pending
            ? "Analysing…"
            : hasProfile
              ? "Re-extract"
              : "Extract voice profile"}
        </Button>
      </div>
      {!enough ? (
        <p className="text-xs text-muted-foreground">
          Paste at least 3 reference posts above and save the brief, then come back to extract.
        </p>
      ) : !hasProfile ? (
        <p className="text-xs text-muted-foreground">
          Claude reads your reference posts and builds a structured voice profile every plan
          generation will mirror.
        </p>
      ) : (
        <ProfileCard profile={profile} extractedAt={extractedAt} />
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ProfileCard({
  profile,
  extractedAt,
}: {
  profile: VoiceProfile;
  extractedAt: string | null;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-background p-3 text-sm">
      <p className="whitespace-pre-wrap text-foreground">{profile.summary}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Pair label="Formality" value={profile.formality} />
        <Pair label="Emoji usage" value={profile.emoji_usage} />
        <Pair label="Avg sentence" value={`${profile.sentence_length_avg.toFixed(0)} words`} />
        <Pair label="From posts" value={`${profile.source_count}`} />
      </dl>
      {profile.signature_phrases.length > 0 ? (
        <Chips title="Signature phrases" items={profile.signature_phrases.slice(0, 6)} />
      ) : null}
      {profile.do_not_say.length > 0 ? (
        <Chips title="Avoid" items={profile.do_not_say.slice(0, 6)} variant="destructive" />
      ) : null}
      {extractedAt ? (
        <p className="text-[11px] text-muted-foreground">
          Extracted {new Date(extractedAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </>
  );
}

function Chips({
  title,
  items,
  variant = "muted",
}: {
  title: string;
  items: string[];
  variant?: "muted" | "destructive";
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((s) => (
          <span
            key={s}
            className={
              variant === "destructive"
                ? "rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-xs text-destructive"
                : "rounded-md border bg-muted px-2 py-0.5 text-xs"
            }
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

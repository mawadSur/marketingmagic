"use client";

// Reference-image video (bet ④ · Capability A) — generate UI.
//
// Upload a reference photo, describe the motion (prompt), pick aspect + duration,
// and affirm the REQUIRED consent checkbox. Submit posts to
// generateReferenceVideoAction, which uploads the photo to the workspace-scoped
// reference-image bucket and calls startReferenceVideoRender (the orchestrator
// re-checks consent and stores the attestation). Only rendered when the feature
// flag is on; the page shows a "not enabled" notice otherwise.

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { generateReferenceVideoAction, type ReferenceVideoState } from "./actions";

const initial: ReferenceVideoState = { error: null, success: null };

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const ASPECTS: Array<{ value: string; label: string }> = [
  { value: "9:16", label: "9:16 — vertical (Reels/TikTok/Shorts)" },
  { value: "16:9", label: "16:9 — landscape" },
  { value: "1:1", label: "1:1 — square" },
];

export function ReferenceImageUploadForm({ keyConfigured }: { keyConfigured: boolean }) {
  const [state, action, pending] = useActionState(generateReferenceVideoAction, initial);
  const [fileName, setFileName] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="reference_image">Reference photo</Label>
        <Input
          id="reference_image"
          name="reference_image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          required
        />
        <p className="text-xs text-muted-foreground">
          A clear photo of the person to animate. JPEG, PNG, or WebP, up to 10MB.
        </p>
        {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="prompt">Motion prompt</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={3}
          placeholder="e.g. slow cinematic push-in, subject smiles and nods, soft natural light"
          required
        />
        <p className="text-xs text-muted-foreground">
          Describe the camera + subject motion. The photo becomes the first frame.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="aspect">Aspect ratio</Label>
          <select id="aspect" name="aspect" defaultValue="9:16" className={SELECT_CLASS}>
            {ASPECTS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="duration_seconds">Duration (seconds)</Label>
          <Input
            id="duration_seconds"
            name="duration_seconds"
            type="number"
            min={1}
            max={60}
            placeholder="5"
          />
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-input bg-muted/20 p-3">
        <input
          id="consent"
          name="consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
          required
        />
        <Label htmlFor="consent" className="text-sm font-normal leading-snug">
          This is me, or I have the documented right to use this person&apos;s likeness.
        </Label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending || !consent || !keyConfigured}>
        {pending ? "Starting render…" : "Generate video"}
      </Button>
      {!keyConfigured ? (
        <p className="text-xs text-muted-foreground">
          Add your fal video key below before generating.
        </p>
      ) : null}
    </form>
  );
}

"use client";

// Reference-image video (bet ④) — generate UI with a MODE toggle:
//   "Animate a photo"  (Capability A) — a reference photo + a motion PROMPT →
//                       fal.ai image-to-video.
//   "Make it talk"     (Capability B) — a reference photo + a SCRIPT (+ optional
//                       voice) → D-ID talking avatar (the person appears to
//                       speak the words).
//
// Submit posts to generateReferenceVideoAction with the active `mode`, which
// uploads the photo to the workspace-scoped reference-image bucket and calls
// startReferenceVideoRender (the orchestrator re-checks consent, enforces the
// per-mode input, and stores the attestation). Only rendered when the feature
// flag is on; the page shows a "not enabled" notice otherwise.
//
// Consent is REQUIRED and STRICTER for "present" — the user is making a real
// person APPEAR TO SPEAK words they may not have said.

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

type Mode = "animate" | "present";
type PresentProvider = "did_video" | "heygen_video";

// Strict, mode-specific consent copy (the orchestrator enforces the same intent
// server-side). "present" is the stricter "appear to say these words" wording.
const CONSENT_COPY: Record<Mode, string> = {
  animate: "This is me, or I have the documented right to use this person's likeness.",
  present:
    "This is me, or I have the documented right to make this person appear to say these words.",
};

export function ReferenceImageUploadForm({
  falConfigured,
  didConfigured,
  heygenConfigured,
}: {
  falConfigured: boolean;
  didConfigured: boolean;
  heygenConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(generateReferenceVideoAction, initial);
  const [fileName, setFileName] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState<Mode>("animate");
  // Which talking-avatar provider the "present" render uses. Submitted as
  // `present_provider`; ignored server-side for "animate" (always fal).
  const [presentProvider, setPresentProvider] = useState<PresentProvider>("did_video");

  const isPresent = mode === "present";
  const isHeygen = presentProvider === "heygen_video";
  // The key the active render needs: present → the chosen provider's key; else fal.
  const activeKeyConfigured = isPresent
    ? isHeygen
      ? heygenConfigured
      : didConfigured
    : falConfigured;

  return (
    <form action={action} className="space-y-5">
      {/* Mode toggle — the submitted `mode` field drives the capability. */}
      <input type="hidden" name="mode" value={mode} />
      {/* The chosen present provider (only consumed server-side for "present"). */}
      <input type="hidden" name="present_provider" value={presentProvider} />
      <div className="inline-flex rounded-lg border bg-muted/30 p-1 text-sm">
        <button
          type="button"
          onClick={() => setMode("animate")}
          aria-pressed={mode === "animate"}
          className={
            mode === "animate"
              ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          Animate a photo
        </button>
        <button
          type="button"
          onClick={() => setMode("present")}
          aria-pressed={mode === "present"}
          className={
            mode === "present"
              ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          Make it talk
        </button>
      </div>

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
          {isPresent
            ? "A clear, front-facing photo of the person who will speak. JPEG, PNG, or WebP, up to 10MB."
            : "A clear photo of the person to animate. JPEG, PNG, or WebP, up to 10MB."}
        </p>
        {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
      </div>

      {isPresent ? (
        <>
          {/* Provider selector — D-ID or HeyGen for the talking-avatar render. */}
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <div className="inline-flex rounded-lg border bg-muted/30 p-1 text-sm">
              <button
                type="button"
                onClick={() => setPresentProvider("did_video")}
                aria-pressed={presentProvider === "did_video"}
                className={
                  presentProvider === "did_video"
                    ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
                    : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                D-ID
              </button>
              <button
                type="button"
                onClick={() => setPresentProvider("heygen_video")}
                aria-pressed={presentProvider === "heygen_video"}
                className={
                  presentProvider === "heygen_video"
                    ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
                    : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                HeyGen
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isHeygen
                ? "HeyGen — higher-quality avatar; pick a HeyGen voice id below."
                : "D-ID — fast, cheapest entry; uses a Microsoft TTS voice."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="script">Script</Label>
            <Textarea
              id="script"
              name="script"
              rows={4}
              placeholder="e.g. Hi, I'm launching something new this week — here's what it means for you."
            />
            <p className="text-xs text-muted-foreground">
              The exact words the person should say. They&apos;ll be spoken and lip-synced.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voice_id">Voice (optional)</Label>
            <Input
              id="voice_id"
              name="voice_id"
              type="text"
              placeholder={isHeygen ? "e.g. a HeyGen voice id" : "e.g. en-US-JennyNeural"}
            />
            <p className="text-xs text-muted-foreground">
              {isHeygen
                ? "A HeyGen voice id. Leave blank to use the deployment default (HeyGen requires a voice)."
                : "A Microsoft TTS voice id. Leave blank to use the deployment default."}
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="prompt">Motion prompt</Label>
          <Textarea
            id="prompt"
            name="prompt"
            rows={3}
            placeholder="e.g. slow cinematic push-in, subject smiles and nods, soft natural light"
          />
          <p className="text-xs text-muted-foreground">
            Describe the camera + subject motion. The photo becomes the first frame.
          </p>
        </div>
      )}

      {!isPresent ? (
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
      ) : null}

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
          {CONSENT_COPY[mode]}
        </Label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending || !consent || !activeKeyConfigured}>
        {pending ? "Starting render…" : isPresent ? "Generate talking video" : "Generate video"}
      </Button>
      {!activeKeyConfigured ? (
        <p className="text-xs text-muted-foreground">
          {isPresent
            ? isHeygen
              ? "Add your HeyGen key below before generating a talking video."
              : "Add your D-ID key below before generating a talking video."
            : "Add your fal video key below before generating."}
        </p>
      ) : null}
    </form>
  );
}

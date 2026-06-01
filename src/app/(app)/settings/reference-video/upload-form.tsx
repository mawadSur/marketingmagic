"use client";

// SPIKE — Reference-image video (bet ④) · upload UI slot.
//
// A single image-upload field that posts to uploadReferenceImageAction. Mirrors
// the org-branding logo form (a file input + a server action returning a
// success/error state). Only rendered when the feature flag is on; the page
// shows a "not enabled" notice otherwise.

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadReferenceImageAction, type ReferenceVideoState } from "./actions";

const initial: ReferenceVideoState = { error: null, success: null };

export function ReferenceImageUploadForm() {
  const [state, action, pending] = useActionState(uploadReferenceImageAction, initial);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="reference_image">Reference photo</Label>
        <Input
          ref={inputRef}
          id="reference_image"
          name="reference_image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          required
        />
        <p className="text-xs text-muted-foreground">
          A clear photo of yourself — used as the likeness reference. JPEG, PNG, or WebP,
          up to 10MB. By uploading you confirm this is you (or that you have the right to
          use this face).
        </p>
        {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Upload reference photo"}
      </Button>
    </form>
  );
}

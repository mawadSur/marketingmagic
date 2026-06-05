"use client";

// UGC avatars — the "add an avatar" form (client).
//
// Name + portrait file → uploadAvatarAction, which uploads to the
// workspace-scoped reference-image bucket and records an avatar row. Mirrors the
// reference-video upload form (settings/reference-video/upload-form.tsx): a
// useActionState form with inline error/success rows and a filename preview.
// Only rendered when the feature flag is on; the page shows a "not enabled"
// notice otherwise.

import { useActionState, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadAvatarAction, type AvatarState } from "./actions";

const initial: AvatarState = { error: null, success: null };

export function AvatarUploadForm() {
  const [state, action, pending] = useActionState(uploadAvatarAction, initial);
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          maxLength={80}
          placeholder="e.g. Jordan — founder"
          required
        />
        <p className="text-xs text-muted-foreground">
          A label so you can pick this presenter later.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reference_image">Portrait</Label>
        <Input
          id="reference_image"
          name="reference_image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          required
        />
        <p className="text-xs text-muted-foreground">
          A clear, front-facing photo of the presenter. JPEG, PNG, or WebP, up to 10MB.
        </p>
        {fileName ? <p className="text-xs text-muted-foreground">Selected: {fileName}</p> : null}
      </div>

      {state.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          {state.success}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Add avatar"}
      </Button>
    </form>
  );
}

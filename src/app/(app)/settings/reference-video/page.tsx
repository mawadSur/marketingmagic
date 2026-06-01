// SPIKE — Reference-image video (bet ④) · settings page.
//
// Upload slot for the user's reference photo (the NEW likeness/image-conditioned
// video path — distinct from the MPT Pexels-stitch pipeline). Gated behind the
// REFERENCE_VIDEO_ENABLED feature flag: when off, renders a "coming soon / not
// enabled" notice and the upload form is not shown, so nothing is live.
//
// Mirrors the video-keys settings page shell. No live provider call happens
// anywhere on this page — see docs/designs/reference-image-video-spike.md.

import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { referenceVideoEnabled } from "@/lib/env";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReferenceImageUploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function ReferenceVideoPage() {
  // Resolve the workspace (auth + redirect) even when flagged off, so the page
  // behaves like every other settings route.
  await getActiveWorkspaceOrRedirect();
  const enabled = referenceVideoEnabled();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reference-image video</h1>
        <p className="text-sm text-muted-foreground">
          Upload a photo of yourself and generate video using it as a likeness reference.
        </p>
      </header>

      {!enabled ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">This feature isn&apos;t enabled yet.</p>
          <p className="mt-1 text-muted-foreground">
            Reference-image video is in development (SPIKE). It will light up once a
            generation provider is wired and an operator sets{" "}
            <code>REFERENCE_VIDEO_ENABLED</code>.
          </p>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your reference photo</CardTitle>
            <CardDescription>
              Stored privately to your workspace. Used as the likeness reference for
              generated video.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReferenceImageUploadForm />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

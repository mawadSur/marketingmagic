// Reference-image video (bet ④ · Capability A) · settings page.
//
// Generate UI for the NEW likeness/image-conditioned video path (distinct from
// the MPT Pexels-stitch pipeline): upload a reference photo, prompt + aspect +
// duration, a REQUIRED consent checkbox → starts a fal.ai image-to-video render.
// Gated behind REFERENCE_VIDEO_ENABLED: when off, renders a "not enabled" notice
// and no form is shown, so nothing is live.

import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { referenceVideoEnabled, byoKeysConfigured } from "@/lib/env";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReferenceImageUploadForm } from "./upload-form";
import { FalVideoKeyForm, FalVideoKeyStatus } from "./key-form";

export const dynamic = "force-dynamic";

export default async function ReferenceVideoPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const enabled = referenceVideoEnabled();

  if (!enabled) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header />
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">This feature isn&apos;t enabled yet.</p>
          <p className="mt-1 text-muted-foreground">
            Reference-image video is gated. It lights up once an operator sets{" "}
            <code>REFERENCE_VIDEO_ENABLED</code>.
          </p>
        </div>
      </div>
    );
  }

  // Presence-only key status — never returns plaintext.
  const byo = byoKeysConfigured();
  const status = byo
    ? await getWorkspaceKeyStatus(ws.id)
    : { llm: false, pexels: false, fal_video: false };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Header />

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">fal video key</CardTitle>
            <CardDescription>
              Bring your own fal.ai key — used to render image-to-video. Stored encrypted.
            </CardDescription>
          </div>
          {byo ? <FalVideoKeyStatus configured={status.fal_video} /> : null}
        </CardHeader>
        <CardContent>
          {byo ? (
            <FalVideoKeyForm configured={status.fal_video} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Credential encryption isn&apos;t configured on this deployment (set{" "}
              <code>BYO_ENCRYPTION_KEY</code>).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Animate a photo</CardTitle>
          <CardDescription>
            Upload a photo and a motion prompt. The render lands in your approval queue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReferenceImageUploadForm keyConfigured={status.fal_video} />
        </CardContent>
      </Card>
    </div>
  );
}

function Header() {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Reference-image video</h1>
      <p className="text-sm text-muted-foreground">
        Upload a photo of yourself and generate video using it as a likeness reference.
      </p>
    </header>
  );
}

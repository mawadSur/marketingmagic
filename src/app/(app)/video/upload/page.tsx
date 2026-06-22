// SLICE A — User video upload · page shell.
//
// Server component that gates the whole feature on USER_VIDEO_UPLOAD_ENABLED and
// renders the direct-to-storage upload client. With the flag off this route 404s
// so the feature stays fully dark (no nav entry points here either until the
// Upload tab is wired in slice E). Workspace membership is enforced by
// getActiveWorkspaceOrRedirect (redirects unauthed/non-members).

import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { userVideoUploadEnabled } from "@/lib/env";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UploadClient } from "./upload-client";

export const dynamic = "force-dynamic";

export default async function VideoUploadPage() {
  if (!userVideoUploadEnabled()) {
    notFound();
  }

  const ws = await getActiveWorkspaceOrRedirect();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Upload a video</h1>
        <p className="text-sm text-muted-foreground">
          Bring your own footage — a talk, a screen recording, a podcast clip. We
          transcribe it, you mark up the moments worth sharing, and we cut
          caption-ready clips you can post.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Choose your video</CardTitle>
          <CardDescription>
            Long videos are fine — uploads go straight to secure storage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UploadClient workspaceId={ws.id} />
        </CardContent>
      </Card>
    </div>
  );
}

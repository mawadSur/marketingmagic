// SLICE A — User video upload · page shell.
//
// Server component that gates the live uploader on USER_VIDEO_UPLOAD_ENABLED.
// With the flag OFF the feature ships as "coming soon": this route renders a
// teaser (UploadComingSoon) instead of 404ing, and the Upload tab links here
// with a "Soon" badge — discoverable, not functional. With the flag ON it
// renders the direct-to-storage upload client. Workspace membership is enforced
// by getActiveWorkspaceOrRedirect (the /video/* prefix is already auth-gated by
// the middleware, so the teaser is only ever seen by signed-in members).

import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { userVideoUploadEnabled } from "@/lib/env";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UploadClient } from "./upload-client";
import { UploadComingSoon } from "./coming-soon";

export const dynamic = "force-dynamic";

export default async function VideoUploadPage() {
  if (!userVideoUploadEnabled()) {
    return <UploadComingSoon />;
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

// UGC avatars (Higgsfield path) — manager page.
//
// A workspace's reusable presenter portraits: upload, set-primary, delete. The
// planner pre-populates UGC renders from the primary avatar (resolveUgcAvatar),
// so the user just approves. Gated behind REFERENCE_VIDEO_ENABLED: when off,
// renders a "not enabled" notice and no manager, so nothing is live. Mirrors the
// reference-video page layout (Card sections, amber not-enabled notice).

import { CheckCircle2 } from "lucide-react";
import { referenceVideoEnabled } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { listAvatars } from "@/lib/video/avatars";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AvatarUploadForm } from "./avatar-manager";
import { setPrimaryAvatarAction, deleteAvatarAction } from "./actions";

export const dynamic = "force-dynamic";

function Header() {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Avatars</h1>
      <p className="text-sm text-muted-foreground">
        Reusable presenter portraits for UGC-style videos. Save an avatar once and pick it for
        every render.
      </p>
    </header>
  );
}

export default async function AvatarsPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  if (!referenceVideoEnabled()) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <Header />
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">This feature isn&apos;t enabled yet.</p>
          <p className="mt-1 text-muted-foreground">
            Avatars are gated. They light up once an operator sets{" "}
            <code>REFERENCE_VIDEO_ENABLED</code>.
          </p>
        </div>
      </div>
    );
  }

  const avatars = await listAvatars(ws.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Header />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Your avatars</h2>
        {avatars.length === 0 ? (
          <EmptyState
            icon="spark"
            title="No avatars yet"
            description="Add a presenter portrait below and it'll appear here, ready to render against."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {avatars.map((avatar) => (
              <li
                key={avatar.id}
                className="flex items-center gap-3 rounded-lg border bg-card p-3"
              >
                {/* Plain <img>: the public URLs aren't allow-listed for
                    next/image, and these are small thumbnails. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={avatar.imageUrl}
                  alt={`${avatar.name} portrait`}
                  width={56}
                  height={56}
                  className="h-14 w-14 shrink-0 rounded-md border object-cover"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{avatar.name}</p>
                    {avatar.isPrimary ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" aria-hidden />
                        Primary
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {!avatar.isPrimary ? (
                      <form action={setPrimaryAvatarAction}>
                        <input type="hidden" name="avatar_id" value={avatar.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Set primary
                        </Button>
                      </form>
                    ) : null}
                    <form action={deleteAvatarAction}>
                      <input type="hidden" name="avatar_id" value={avatar.id} />
                      <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                        Delete
                      </Button>
                    </form>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add an avatar</CardTitle>
          <CardDescription>
            Upload a portrait of the presenter. The first avatar you add becomes the primary.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AvatarUploadForm />
        </CardContent>
      </Card>
    </div>
  );
}

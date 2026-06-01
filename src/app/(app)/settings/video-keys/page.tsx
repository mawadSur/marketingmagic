import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { mptConfigured, byoKeysConfigured } from "@/lib/env";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LlmKeyForm, PexelsKeyForm, KeyStatus } from "./key-forms";

export const dynamic = "force-dynamic";

export default async function VideoKeysPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  // Gate on platform configuration. If MPT isn't wired up or we can't encrypt
  // BYO secrets, there's nothing the user can usefully do here — show why.
  const mpt = mptConfigured();
  const byo = byoKeysConfigured();
  if (!mpt || !byo) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Video keys</h1>
          <p className="text-sm text-muted-foreground">
            Bring your own LLM + Pexels keys to render videos.
          </p>
        </header>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Video generation isn&apos;t available on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            {!mpt && (
              <>
                The render worker isn&apos;t configured (set <code>MPT_BASE_URL</code> and{" "}
                <code>MPT_API_TOKEN</code>).{" "}
              </>
            )}
            {!byo && (
              <>
                Credential encryption isn&apos;t configured (set <code>BYO_ENCRYPTION_KEY</code>).
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  // Presence-only — never returns plaintext. Drives the Configured/Not pills.
  const status = await getWorkspaceKeyStatus(ws.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Video keys</h1>
        <p className="text-sm text-muted-foreground">
          You bring your own LLM + Pexels keys; we render the video. Keys are stored encrypted and
          never shown again — you can Replace or Remove them, but not read them back.
        </p>
      </header>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">LLM provider</CardTitle>
            <CardDescription>
              Generates the script + on-screen terms. Use a model your key can access.
            </CardDescription>
          </div>
          <KeyStatus configured={status.llm} provider="llm" />
        </CardHeader>
        <CardContent>
          <LlmKeyForm configured={status.llm} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Pexels</CardTitle>
            <CardDescription>Supplies the stock B-roll clips behind your narration.</CardDescription>
          </div>
          <KeyStatus configured={status.pexels} provider="pexels" />
        </CardHeader>
        <CardContent>
          <PexelsKeyForm configured={status.pexels} />
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Keys set?{" "}
        <Link className="underline underline-offset-4" href="/video">
          Generate a video →
        </Link>
      </p>
    </div>
  );
}

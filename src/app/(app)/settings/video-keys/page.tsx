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
  const doneCount = (status.llm ? 1 : 0) + (status.pexels ? 1 : 0);
  const allSet = doneCount === 2;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Video keys</h1>
        <p className="text-sm text-muted-foreground">
          Two keys and you can render. Bring your own LLM + Pexels keys — both stored encrypted and
          never shown again (Replace or Remove, but not read back).
        </p>
        <div className="flex items-center gap-3 pt-1">
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${(doneCount / 2) * 100}%` }}
            />
          </div>
          <span className="text-xs font-medium text-muted-foreground">{doneCount} of 2 set</span>
        </div>
      </header>

      {allSet ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium">Both keys set — you&apos;re ready to render.</p>
          <Link
            href="/video"
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Generate a video →
          </Link>
        </div>
      ) : null}

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

      {!allSet ? (
        <p className="text-sm text-muted-foreground">
          Add both keys above, then{" "}
          <Link className="underline underline-offset-4" href="/video">
            generate a video →
          </Link>
        </p>
      ) : null}
    </div>
  );
}

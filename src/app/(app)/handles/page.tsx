import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { HandleFinder } from "@/app/onboarding/handles/handle-finder";

export const dynamic = "force-dynamic";

// Standalone handle-finder — the same tool available during onboarding, surfaced
// as a first-class app page so existing users can find + check usernames any
// time (not just first run). Reuses the onboarding HandleFinder client component
// + its server actions; nothing duplicated.
export default async function HandlesToolPage() {
  await getActiveWorkspaceOrRedirect();

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-8">
      <header className="space-y-2">
        <p className="label-eyebrow">Tools</p>
        <h1 className="text-2xl font-semibold tracking-tight">Find an available handle</h1>
        <p className="text-sm text-muted-foreground">
          Generate brandable usernames from your brand, see where they&apos;re free across every
          platform, and jump straight to sign up. One handle everywhere makes you findable.
        </p>
      </header>

      <HandleFinder />
    </div>
  );
}

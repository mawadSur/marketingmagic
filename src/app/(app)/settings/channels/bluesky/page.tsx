import { BlueskyConnectForm } from "./bluesky-connect-form";

export default function ConnectBlueskyPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect Bluesky</h1>
        <p className="text-sm text-muted-foreground">
          Bluesky uses app passwords — no OAuth flow. Create one at{" "}
          <a
            className="underline-offset-4 hover:underline"
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer"
          >
            bsky.app/settings/app-passwords
          </a>{" "}
          (don&apos;t use your main login password). We verify before storing.
        </p>
      </header>
      <BlueskyConnectForm />
    </div>
  );
}

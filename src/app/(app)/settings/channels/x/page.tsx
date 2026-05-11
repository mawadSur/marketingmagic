import { XConnectForm } from "./x-connect-form";

export default function ConnectXPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect X</h1>
        <p className="text-sm text-muted-foreground">
          Manual paste flow (V0). Generate API keys + access tokens at{" "}
          <a
            href="https://developer.x.com/en/portal/dashboard"
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 hover:underline"
          >
            developer.x.com
          </a>{" "}
          with the read+write user-context scope, then paste them below. We verify the credentials
          before storing.
        </p>
      </header>
      <XConnectForm />
    </div>
  );
}

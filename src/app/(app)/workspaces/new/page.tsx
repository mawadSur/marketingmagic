import { NewWorkspaceForm } from "./new-workspace-form";

export default function NewWorkspacePage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New workspace</h1>
        <p className="text-sm text-muted-foreground">
          Workspaces are isolated tenants. Brand briefs, posts, and channels never leak between them.
        </p>
      </header>
      <NewWorkspaceForm />
    </div>
  );
}

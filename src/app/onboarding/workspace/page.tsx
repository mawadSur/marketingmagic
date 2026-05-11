import { redirect } from "next/navigation";
import { getAuthedUserOrRedirect, listWorkspaces } from "@/lib/workspace";
import { WorkspaceForm } from "./workspace-form";

export default async function OnboardingWorkspacePage() {
  await getAuthedUserOrRedirect();
  const workspaces = await listWorkspaces();
  if (workspaces.length > 0) redirect("/dashboard");

  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="text-sm text-muted-foreground">
            One workspace per client or product. You can add more later.
          </p>
        </div>
        <WorkspaceForm />
      </div>
    </main>
  );
}

"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWorkspaceAction, type CreateWorkspaceState } from "@/app/onboarding/workspace/actions";

const initial: CreateWorkspaceState = { error: null };

export function NewWorkspaceForm() {
  const [state, formAction, pending] = useActionState(createWorkspaceAction, initial);
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Workspace name</Label>
        <Input id="name" name="name" required maxLength={60} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}

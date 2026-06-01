"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createOrganizationAction,
  addClientAction,
  type CreateOrgState,
  type AddClientState,
} from "./actions";

const createInitial: CreateOrgState = { error: null };
const addClientInitial: AddClientState = { error: null };

// Shown when the user has no organization yet — promotes solo → agency.
export function CreateOrganizationForm() {
  const [state, formAction, pending] = useActionState(createOrganizationAction, createInitial);
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="org-name">Agency name</Label>
        <Input id="org-name" name="name" required maxLength={60} placeholder="Acme Social" />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}

// Shown once an org exists — mints a new client workspace under it.
export function AddClientForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, pending] = useActionState(addClientAction, addClientInitial);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="organization_id" value={organizationId} />
      <div className="flex-1 space-y-2">
        <Label htmlFor="client-name">Client name</Label>
        <Input id="client-name" name="name" required maxLength={60} placeholder="Client co." />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add client"}
      </Button>
      {state.error ? (
        <p className="w-full text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generatePlanAction, type GeneratePlanState } from "./actions";

interface XAccount {
  id: string;
  channel: string;
  handle: string;
}

const initial: GeneratePlanState = { error: null, planId: null };

export function NewPlanForm({ xAccounts }: { xAccounts: XAccount[] }) {
  const [state, formAction, pending] = useActionState(generatePlanAction, initial);

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="x_account_id">X account</Label>
        <select
          id="x_account_id"
          name="x_account_id"
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {xAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.handle}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="weeks">Weeks</Label>
          <Input id="weeks" name="weeks" type="number" defaultValue={1} min={1} max={4} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="posts_per_week">Posts / week</Label>
          <Input
            id="posts_per_week"
            name="posts_per_week"
            type="number"
            defaultValue={7}
            min={1}
            max={28}
            required
          />
        </div>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.planId ? (
        <p className="text-sm text-emerald-600">Plan generated. Redirecting…</p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Generating (≈30s)…" : "Generate plan"}
      </Button>
    </form>
  );
}

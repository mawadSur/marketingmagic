"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Database } from "@/lib/db/types";
import {
  createEventRuleAction,
  deleteEventRuleAction,
  toggleEventRuleAction,
} from "./actions";

type Rule = Database["public"]["Tables"]["event_rules"]["Row"];

export function EventRulesEditor({ rules }: { rules: Rule[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ error: string | null }>) {
    start(async () => {
      const r = await action();
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Rules</h2>
        <p className="text-sm text-muted-foreground">
          When an event_type matches, the template is rendered with{" "}
          <code className="rounded bg-muted px-1">{"{{var}}"}</code> substitution against the payload
          and queued as a post draft.
        </p>
      </header>

      {rules.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {rules.map((rule) => (
            <li key={rule.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{rule.event_type}</p>
                  <p className="text-xs text-muted-foreground">
                    {rule.channels.join(", ")}
                    {rule.theme ? ` · #${rule.theme}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => run(() => toggleEventRuleAction(rule.id, !rule.enabled))}
                    disabled={pending}
                  >
                    {rule.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => run(() => deleteEventRuleAction(rule.id))}
                    disabled={pending}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <pre className="overflow-x-auto rounded-md border bg-muted/50 p-2 text-xs">
{rule.template}
              </pre>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          No rules yet. Add one below.
        </p>
      )}

      <form
        action={(formData) => run(() => createEventRuleAction(formData))}
        className="space-y-4 rounded-lg border p-4"
      >
        <h3 className="text-sm font-medium">New rule</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="event_type">Event type</Label>
            <Input id="event_type" name="event_type" placeholder="new_winner" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="theme">Theme tag</Label>
            <Input id="theme" name="theme" placeholder="winner-announcement" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="channels">Channels (comma-separated)</Label>
          <Input id="channels" name="channels" defaultValue="x" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="template">Template</Label>
          <Textarea
            id="template"
            name="template"
            rows={3}
            required
            placeholder={"this week's winner: {{title}} — {{score}}/100. building it now → {{url}}"}
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add rule"}
        </Button>
      </form>
    </section>
  );
}

"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { buildInPublicAction, type BuildInPublicState } from "./actions";

const initial: BuildInPublicState = { error: null };

// Founder-native "turn your build into posts" form. One big textarea +
// one button — deliberately fewer controls than /sources/new because the
// whole pitch is "paste your raw updates, get a week of posts." No URL
// tab, no rights checkbox (it's your own work), no separate title field.
export function BuildInPublicForm() {
  const [state, formAction, pending] = useActionState(buildInPublicAction, initial);

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="updates">Paste what you shipped this week</Label>
        <Textarea
          id="updates"
          name="updates"
          rows={12}
          placeholder={
            "Bullet points are fine. Brain-dump it:\n" +
            "- Shipped the new onboarding wizard, cut signup-to-first-post from 4 min to 40s\n" +
            "- Fixed the gnarly OAuth bug that was dropping mobile connects\n" +
            "- Hit 50 paying users, still no marketing spend\n" +
            "- Spent 2 days fighting a webhook race condition, finally won"
          }
          required
          minLength={50}
          className="text-sm leading-relaxed"
        />
        <p className="text-xs text-muted-foreground">
          Changelog, launch notes, a Slack-to-yourself — whatever you’ve got. ~3–6 updates gives
          the best week. We write the posts in your voice and lead with X.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending
          ? "Writing your week of build-in-public posts (≈15s)…"
          : "Turn my build into a week of posts"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Lands as real drafts in your queue. Nothing posts until you say so.
      </p>
    </form>
  );
}

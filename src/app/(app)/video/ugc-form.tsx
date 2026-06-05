"use client";

// UGC avatar video form — pick a SAVED avatar + type a script, render a talking
// clip via Higgsfield (the "present" path). Mirrors GenerateVideoForm's shape
// (useActionState + the shared GenerateVideoState, with the needsKeys/quota deep
// links), but the photo comes from a stored avatar instead of an upload, and a
// consent checkbox is required (UGC implies the avatar is owned).
//
// When the workspace has no avatars the parent renders a notice linking to
// /settings/avatars instead of this form — so here we can assume avatars.length>0.

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { generateUgcVideoAction, type GenerateVideoState } from "./actions";
import type { DestinationAccount } from "./generate-form";

const initial: GenerateVideoState = { error: null, success: null, needsKeys: false, quota: false };

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export interface UgcAvatarOption {
  id: string;
  name: string;
  isPrimary: boolean;
}

export function GenerateUgcForm({
  avatars,
  accounts,
}: {
  avatars: UgcAvatarOption[];
  accounts: DestinationAccount[];
}) {
  const [state, action, pending] = useActionState(generateUgcVideoAction, initial);
  // Primary-first, so the default selection is the workspace's primary avatar.
  const defaultAvatar = avatars.find((a) => a.isPrimary)?.id ?? avatars[0]?.id ?? "";

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="avatarId">Avatar</Label>
        <select id="avatarId" name="avatarId" defaultValue={defaultAvatar} className={SELECT_CLASS}>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.isPrimary ? " (primary)" : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The saved avatar that will speak your script.{" "}
          <Link href="/settings/avatars" className="font-medium underline underline-offset-4">
            Manage avatars →
          </Link>
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="script">Script</Label>
        <Textarea
          id="script"
          name="script"
          rows={4}
          placeholder="The exact words the avatar should say."
          required
          maxLength={4000}
        />
        <p className="text-xs text-muted-foreground">
          We&apos;ll lip-sync the avatar to these words.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="videoSubject">Subject (optional)</Label>
        <Input
          id="videoSubject"
          name="videoSubject"
          placeholder="e.g. New product launch teaser"
          maxLength={500}
        />
        <p className="text-xs text-muted-foreground">
          A short label that seeds the draft post caption. Leave blank to use the script.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="socialAccountId">Publish to</Label>
        <select id="socialAccountId" name="socialAccountId" defaultValue="" className={SELECT_CLASS}>
          <option value="">Save to library (choose a channel later)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          When the render finishes we&apos;ll attach it to a draft post for this channel, ready for
          your approval. Pick &quot;Save to library&quot; to decide later.
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="consent"
          value="on"
          className="mt-0.5 h-4 w-4 rounded border-input"
          required
        />
        <span className="text-muted-foreground">
          I confirm this is me, or that I own this avatar / have the documented right to make this
          person appear to say these words.
        </span>
      </label>

      {state.error ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">{state.error}</p>
          {state.needsKeys ? (
            <Link
              href="/settings/reference-video"
              className="font-medium underline underline-offset-4"
            >
              Add your Higgsfield key →
            </Link>
          ) : null}
          {state.quota ? (
            <Link href="/settings/billing" className="font-medium underline underline-offset-4">
              Upgrade your plan →
            </Link>
          ) : null}
        </div>
      ) : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Starting render…" : "Generate UGC video"}
      </Button>
    </form>
  );
}

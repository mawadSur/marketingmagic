"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { generateVideoAction, type GenerateVideoState } from "./actions";

const initial: GenerateVideoState = { error: null, success: null, needsKeys: false, quota: false };

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export interface DestinationAccount {
  id: string;
  label: string;
}

export function GenerateVideoForm({ accounts }: { accounts: DestinationAccount[] }) {
  const [state, action, pending] = useActionState(generateVideoAction, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="videoSubject">Subject</Label>
        <Input
          id="videoSubject"
          name="videoSubject"
          placeholder="e.g. 3 productivity tips for founders"
          required
          maxLength={500}
        />
        <p className="text-xs text-muted-foreground">
          What the video is about. We&apos;ll script it from this unless you provide your own.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="videoScript">Script (optional)</Label>
        <Textarea
          id="videoScript"
          name="videoScript"
          rows={4}
          placeholder="Leave blank to let your LLM write it from the subject."
          maxLength={5000}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="videoAspect">Aspect ratio</Label>
          <select id="videoAspect" name="videoAspect" defaultValue="9:16" className={SELECT_CLASS}>
            <option value="9:16">9:16 — Vertical (Reels, Shorts, TikTok)</option>
            <option value="16:9">16:9 — Landscape (YouTube)</option>
            <option value="1:1">1:1 — Square (feed)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="voiceName">Voice (optional)</Label>
          <Input id="voiceName" name="voiceName" placeholder="en-US-JennyNeural-Female" maxLength={120} />
          <p className="text-xs text-muted-foreground">
            Leave blank to use the default narrator (en-US-JennyNeural). Use the
            <code className="mx-1">locale-VoiceNeural-Gender</code> format, e.g.
            <code className="ml-1">en-US-GuyNeural-Male</code>.
          </p>
        </div>
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

      {state.error ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">{state.error}</p>
          {state.needsKeys ? (
            <Link href="/settings/video-keys" className="font-medium underline underline-offset-4">
              Set up your video keys →
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
        {pending ? "Starting render…" : "Generate video"}
      </Button>
    </form>
  );
}

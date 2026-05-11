"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Database } from "@/lib/db/types";
import { saveBriefAction, type SaveBriefState } from "./actions";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

const initial: SaveBriefState = { error: null, savedAt: null };

export function BriefForm({ initial: brief }: { initial: Brief | null }) {
  const [state, formAction, pending] = useActionState(saveBriefAction, initial);

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="product_description">Product description</Label>
        <Textarea
          id="product_description"
          name="product_description"
          rows={4}
          required
          defaultValue={brief?.product_description ?? ""}
          placeholder="What is the product? Who uses it? What's the wedge?"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="voice">Voice</Label>
        <Textarea
          id="voice"
          name="voice"
          rows={4}
          required
          defaultValue={brief?.voice ?? ""}
          placeholder="Specific, plain, not over-engineered. Avoids hype-words. Adjectives only when load-bearing."
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="target_audience">Target audience</Label>
        <Textarea
          id="target_audience"
          name="target_audience"
          rows={3}
          required
          defaultValue={brief?.target_audience ?? ""}
          placeholder="Indie hackers, technical solo founders, builders shipping side projects."
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="do_not_say">Do not say (one per line)</Label>
        <Textarea
          id="do_not_say"
          name="do_not_say"
          rows={3}
          defaultValue={(brief?.do_not_say ?? []).join("\n")}
          placeholder={"synergy\nrevolutionize\ngame-changer"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reference_links">Reference links (one per line)</Label>
        <Textarea
          id="reference_links"
          name="reference_links"
          rows={3}
          defaultValue={(brief?.reference_links ?? []).join("\n")}
          placeholder={"https://yourproduct.com\nhttps://yourblog.com/why-we-built-this"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reference_posts">Reference posts (one per line, voice exemplars)</Label>
        <Textarea
          id="reference_posts"
          name="reference_posts"
          rows={4}
          defaultValue={(brief?.reference_posts ?? []).join("\n")}
          placeholder={"shipped X this week\nturns out the bug was Y, not Z"}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : brief ? "Update brief" : "Save brief"}
        </Button>
        {state.savedAt ? (
          <span className="text-xs text-muted-foreground">
            Saved {new Date(state.savedAt).toLocaleTimeString()}
          </span>
        ) : null}
        {state.error ? <span className="text-sm text-destructive">{state.error}</span> : null}
      </div>
      <input type="hidden" name="brief_id" value={brief?.id ?? ""} />
    </form>
  );
}

"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Database } from "@/lib/db/types";
import { saveBriefAction, suggestBriefFromUrlAction, type SaveBriefState } from "./actions";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

const initial: SaveBriefState = { error: null, savedAt: null };

interface FormState {
  product_description: string;
  voice: string;
  target_audience: string;
  do_not_say: string;
  reference_links: string;
  reference_posts: string;
}

function fromBrief(b: Brief | null): FormState {
  return {
    product_description: b?.product_description ?? "",
    voice: b?.voice ?? "",
    target_audience: b?.target_audience ?? "",
    do_not_say: (b?.do_not_say ?? []).join("\n"),
    reference_links: (b?.reference_links ?? []).join("\n"),
    reference_posts: (b?.reference_posts ?? []).join("\n"),
  };
}

export function BriefForm({ initial: brief }: { initial: Brief | null }) {
  const [state, formAction, pending] = useActionState(saveBriefAction, initial);
  const [values, setValues] = useState<FormState>(() => fromBrief(brief));

  const [websiteUrl, setWebsiteUrl] = useState("");
  const [aiPending, startAi] = useTransition();
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  function fillWithAi() {
    setAiError(null);
    setAiNote(null);
    startAi(async () => {
      const result = await suggestBriefFromUrlAction(websiteUrl);
      if (result.error || !result.data) {
        setAiError(result.error ?? "AI fill failed.");
        return;
      }
      // Merge: only overwrite fields the user hasn't customized away from the
      // initial DB state. Pure-empty fields always get filled.
      setValues((v) => ({
        product_description: v.product_description || result.data!.product_description,
        voice: v.voice || result.data!.voice,
        target_audience: v.target_audience || result.data!.target_audience,
        do_not_say: v.do_not_say || result.data!.do_not_say.join("\n"),
        reference_links: v.reference_links || result.data!.reference_links.join("\n"),
        reference_posts: v.reference_posts || result.data!.reference_posts.join("\n"),
      }));
      setAiNote("Filled empty fields. Edit anything you don't like before saving.");
    });
  }

  return (
    <form action={formAction} className="space-y-5">
      {/* AI fill block */}
      <div className="space-y-2 rounded-md border bg-muted/30 p-4">
        <Label htmlFor="website_url">Website (fill with AI)</Label>
        <div className="flex gap-2">
          <Input
            id="website_url"
            type="url"
            placeholder="https://yourproduct.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={aiPending || websiteUrl.trim().length < 8}
            onClick={fillWithAi}
          >
            {aiPending ? "Reading…" : "Fill with AI"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Claude reads the page and seeds the empty fields below. Already-filled fields are left alone.
        </p>
        {aiError ? <p className="text-sm text-destructive">{aiError}</p> : null}
        {aiNote ? <p className="text-sm text-emerald-600">{aiNote}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="product_description">Product description</Label>
        <Textarea
          id="product_description"
          name="product_description"
          rows={4}
          required
          value={values.product_description}
          onChange={(e) => set("product_description", e.target.value)}
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
          value={values.voice}
          onChange={(e) => set("voice", e.target.value)}
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
          value={values.target_audience}
          onChange={(e) => set("target_audience", e.target.value)}
          placeholder="Indie hackers, technical solo founders, builders shipping side projects."
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="do_not_say">Do not say (one per line)</Label>
        <Textarea
          id="do_not_say"
          name="do_not_say"
          rows={3}
          value={values.do_not_say}
          onChange={(e) => set("do_not_say", e.target.value)}
          placeholder={"synergy\nrevolutionize\ngame-changer"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reference_links">Reference links (one per line)</Label>
        <Textarea
          id="reference_links"
          name="reference_links"
          rows={3}
          value={values.reference_links}
          onChange={(e) => set("reference_links", e.target.value)}
          placeholder={"https://yourproduct.com\nhttps://yourblog.com/why-we-built-this"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reference_posts">Reference posts (one per line, voice exemplars)</Label>
        <Textarea
          id="reference_posts"
          name="reference_posts"
          rows={4}
          value={values.reference_posts}
          onChange={(e) => set("reference_posts", e.target.value)}
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

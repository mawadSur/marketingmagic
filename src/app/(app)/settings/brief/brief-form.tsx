"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Database } from "@/lib/db/types";
import { saveBriefAction, suggestBriefFromUrlAction, type SaveBriefState } from "./actions";
import { ExtractVoiceButton } from "./extract-voice-button";

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
    <form action={formAction} className="space-y-6">
      {/* AI fill block */}
      <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-foreground text-[10px] font-bold text-background">
            AI
          </span>
          <Label htmlFor="website_url" className="text-sm">Fill from your website</Label>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="website_url"
            type="url"
            placeholder="https://yourproduct.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            className="transition-colors duration-200"
          />
          <Button
            type="button"
            variant="outline"
            disabled={aiPending || websiteUrl.trim().length < 8}
            onClick={fillWithAi}
            className="sm:shrink-0"
          >
            {aiPending ? "Reading…" : "Fill with AI"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Claude reads the page and seeds any empty fields below. Already-filled fields are left alone.
        </p>
        {aiError ? <p className="text-xs text-destructive">{aiError}</p> : null}
        {aiNote ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{aiNote}</p>
        ) : null}
      </div>

      <Field
        id="product_description"
        label="Product description"
        helper="What is it, who uses it, and what's the wedge?"
      >
        <Textarea
          id="product_description"
          name="product_description"
          rows={4}
          required
          value={values.product_description}
          onChange={(e) => set("product_description", e.target.value)}
          placeholder="What is the product? Who uses it? What's the wedge?"
        />
      </Field>

      <Field
        id="voice"
        label="Voice"
        helper="Specific traits, not adjectives. Claude will mirror this."
      >
        <Textarea
          id="voice"
          name="voice"
          rows={4}
          required
          value={values.voice}
          onChange={(e) => set("voice", e.target.value)}
          placeholder="Specific, plain, not over-engineered. Avoids hype-words. Adjectives only when load-bearing."
        />
      </Field>

      <Field
        id="target_audience"
        label="Target audience"
        helper="Be concrete — job titles, contexts, what they care about."
      >
        <Textarea
          id="target_audience"
          name="target_audience"
          rows={3}
          required
          value={values.target_audience}
          onChange={(e) => set("target_audience", e.target.value)}
          placeholder="Indie hackers, technical solo founders, builders shipping side projects."
        />
      </Field>

      <Field
        id="do_not_say"
        label="Do not say"
        helper="One forbidden phrase per line. Claude will steer around them."
      >
        <Textarea
          id="do_not_say"
          name="do_not_say"
          rows={3}
          value={values.do_not_say}
          onChange={(e) => set("do_not_say", e.target.value)}
          placeholder={"synergy\nrevolutionize\ngame-changer"}
        />
      </Field>

      <Field
        id="reference_links"
        label="Reference links"
        helper="One URL per line — homepage, manifestos, anything that captures the why."
      >
        <Textarea
          id="reference_links"
          name="reference_links"
          rows={3}
          value={values.reference_links}
          onChange={(e) => set("reference_links", e.target.value)}
          placeholder={"https://yourproduct.com\nhttps://yourblog.com/why-we-built-this"}
        />
      </Field>

      <Field
        id="reference_posts"
        label="Reference posts"
        helper="Paste 5–20 of your own posts, one per line. The voice extractor below pattern-matches against these."
      >
        <Textarea
          id="reference_posts"
          name="reference_posts"
          rows={6}
          value={values.reference_posts}
          onChange={(e) => set("reference_posts", e.target.value)}
          placeholder={"shipped X this week\nturns out the bug was Y, not Z"}
        />
      </Field>

      <ExtractVoiceButton
        initialProfile={brief?.voice_profile ?? null}
        initialExtractedAt={brief?.voice_profile_extracted_at ?? null}
        referencePostsCount={values.reference_posts.split("\n").map((s) => s.trim()).filter(Boolean).length}
      />

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : brief ? "Update brief" : "Save brief"}
        </Button>
        {state.savedAt ? (
          <span className="text-xs text-muted-foreground">
            Saved {new Date(state.savedAt).toLocaleTimeString()}
          </span>
        ) : null}
        {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
      </div>
      <input type="hidden" name="brief_id" value={brief?.id ?? ""} />
    </form>
  );
}

function Field({
  id,
  label,
  helper,
  children,
}: {
  id: string;
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {helper ? <p className="text-xs text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

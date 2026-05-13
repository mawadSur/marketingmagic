"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  saveBriefAction,
  suggestBriefFromUrlAction,
  type BriefSuggestion,
  type SaveBriefState,
} from "@/app/(app)/settings/brief/actions";

interface ExistingBrief {
  product_description: string | null;
  voice: string | null;
  target_audience: string | null;
  do_not_say: string[] | null;
  reference_links: string[] | null;
  reference_posts: string[] | null;
}

interface FormState {
  product_description: string;
  voice: string;
  target_audience: string;
  do_not_say: string;
  reference_links: string;
  reference_posts: string;
}

function fromBrief(b: ExistingBrief | null): FormState {
  return {
    product_description: b?.product_description ?? "",
    voice: b?.voice ?? "",
    target_audience: b?.target_audience ?? "",
    do_not_say: (b?.do_not_say ?? []).join("\n"),
    reference_links: (b?.reference_links ?? []).join("\n"),
    reference_posts: (b?.reference_posts ?? []).join("\n"),
  };
}

function mergeFromSuggestion(prev: FormState, s: BriefSuggestion): FormState {
  // Only overwrite fields the user hasn't filled in yet — same rule as the
  // existing brief form. Keeps user edits intact across re-runs.
  return {
    product_description: prev.product_description || s.product_description,
    voice: prev.voice || s.voice,
    target_audience: prev.target_audience || s.target_audience,
    do_not_say: prev.do_not_say || s.do_not_say.join("\n"),
    reference_links: prev.reference_links || s.reference_links.join("\n"),
    reference_posts: prev.reference_posts || s.reference_posts.join("\n"),
  };
}

const initialSave: SaveBriefState = { error: null, savedAt: null };

interface Step1Props {
  initialBrief: ExistingBrief | null;
}

/**
 * Step 1: collect the brand brief. The hero is the URL input — paste a
 * website, Claude reads it, and the 6 brief fields come back pre-filled
 * and editable. Saving advances to Step 2.
 */
export function Step1Brief({ initialBrief }: Step1Props) {
  const router = useRouter();
  const [saveState, saveFormAction, savePending] = useActionState(saveBriefAction, initialSave);
  const [values, setValues] = useState<FormState>(() => fromBrief(initialBrief));
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [aiPending, startAi] = useTransition();
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiDone, setAiDone] = useState(false);
  // Reveal the editable fields once the user has either filled in AI
  // suggestions or chose to type from scratch. Starts true if we have an
  // existing brief — there's something to show already.
  const [revealed, setRevealed] = useState<boolean>(initialBrief !== null);

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  function readMySite() {
    setAiError(null);
    setAiDone(false);
    startAi(async () => {
      const result = await suggestBriefFromUrlAction(websiteUrl);
      if (result.error || !result.data) {
        setAiError(result.error ?? "Couldn't read that URL.");
        return;
      }
      setValues((v) => mergeFromSuggestion(v, result.data!));
      setAiDone(true);
      setRevealed(true);
    });
  }

  // Save succeeded — advance. useEffect so we don't push during render.
  useEffect(() => {
    if (saveState.savedAt) router.push("/onboarding/wizard?step=2");
  }, [saveState.savedAt, router]);

  return (
    <div className="space-y-6">
      {/* AI fill hero */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="space-y-1">
            <Label htmlFor="website_url" className="text-sm font-medium">
              Your website
            </Label>
            <p className="text-xs text-muted-foreground">
              Paste a URL and we&apos;ll read the page to figure out what you do, who you sell to,
              and how you talk. Edit anything you don&apos;t like before saving.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="website_url"
              type="url"
              placeholder="https://yourproduct.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              onClick={readMySite}
              disabled={aiPending || websiteUrl.trim().length < 8}
              className="sm:w-44"
            >
              {aiPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Reading…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                  Read my site
                </>
              )}
            </Button>
          </div>
          {aiError ? <p className="text-sm text-destructive">{aiError}</p> : null}
          {aiDone ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Got it. Review the fields below and tweak anything that&apos;s off.
            </p>
          ) : null}
          {!revealed ? (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Or fill it in manually →
            </button>
          ) : null}
        </CardContent>
      </Card>

      {/* AI loading skeleton */}
      {aiPending && !revealed ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-20 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Editable brief fields — appear once the user has run AI or opted into manual */}
      {revealed ? (
        <form action={saveFormAction} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="product_description">Product</Label>
            <Textarea
              id="product_description"
              name="product_description"
              rows={3}
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
              placeholder="How you write. Be specific — quote the way you actually phrase things."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="target_audience">Audience</Label>
            <Textarea
              id="target_audience"
              name="target_audience"
              rows={2}
              required
              value={values.target_audience}
              onChange={(e) => set("target_audience", e.target.value)}
              placeholder="Who reads, buys, or shares. The more specific the better."
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="do_not_say">Do not say</Label>
              <Textarea
                id="do_not_say"
                name="do_not_say"
                rows={3}
                value={values.do_not_say}
                onChange={(e) => set("do_not_say", e.target.value)}
                placeholder={"one per line\ne.g. synergy\ngame-changer"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reference_links">Reference links</Label>
              <Textarea
                id="reference_links"
                name="reference_links"
                rows={3}
                value={values.reference_links}
                onChange={(e) => set("reference_links", e.target.value)}
                placeholder={"one URL per line"}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reference_posts">Reference posts (voice examples)</Label>
            <Textarea
              id="reference_posts"
              name="reference_posts"
              rows={3}
              value={values.reference_posts}
              onChange={(e) => set("reference_posts", e.target.value)}
              placeholder={"Real posts you've shipped that sound right. One per line."}
            />
          </div>

          {saveState.error ? <p className="text-sm text-destructive">{saveState.error}</p> : null}

          <Button type="submit" disabled={savePending} className="w-full" size="lg">
            {savePending ? "Saving…" : "Save brief and continue"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

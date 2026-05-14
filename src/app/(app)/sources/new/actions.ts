"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { fetchSource, UnsupportedSourceError, ColdSourceError } from "@/lib/sources/fetch";
import { extractFromSource } from "@/lib/sources/extract-claude";
import type { Json } from "@/lib/db/types";

// /sources/new server action.
//
// Pipeline: form submit → narrow mode → fetchSource() → extractFromSource()
// → insert one `sources` row with title + url + extracted_* columns → redirect
// to /sources/[id].
//
// We do NOT generate the cluster here — that's a second step on the detail
// page. Two-step flow because:
//   - Extraction is fast (1 Claude call, ~3-5s); cluster generation is slow
//     (3-30s). Surfacing the extracted summary mid-flow lets the user sanity-
//     check before committing to a 30s plan generation.
//   - Lets the user delete/edit a bad extraction without burning a planner
//     run on garbage input.

export type IngestSourceState = { error: string | null; sourceId: string | null };

const formSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("url"),
    url: z.string().trim().url("Enter a valid URL (https://example.com)."),
    title: z.string().trim().max(280).optional(),
    rights_ok: z.literal("on", { errorMap: () => ({ message: "Tick the rights checkbox to continue." }) }),
  }),
  z.object({
    mode: z.literal("paste"),
    text: z
      .string()
      .trim()
      .min(50, "Paste at least 50 characters of source text.")
      .max(60_000, "Source is too long — trim to the most relevant 60k characters."),
    title: z.string().trim().min(1, "Give the source a short title.").max(280),
    rights_ok: z.literal("on", { errorMap: () => ({ message: "Tick the rights checkbox to continue." }) }),
  }),
]);

export async function ingestSourceAction(
  _prev: IngestSourceState,
  formData: FormData,
): Promise<IngestSourceState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();

  const mode = formData.get("mode") === "url" ? "url" : "paste";
  const parsed = formSchema.safeParse({
    mode,
    url: formData.get("url") ?? "",
    text: formData.get("text") ?? "",
    title: formData.get("title") ?? "",
    rights_ok: formData.get("rights_ok") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form fields.", sourceId: null };
  }

  // Step 1 — fetch (or normalize a paste) into a RawSource blob.
  let raw;
  try {
    if (parsed.data.mode === "url") {
      raw = await fetchSource({
        mode: "url",
        url: parsed.data.url,
        title: parsed.data.title,
      });
    } else {
      raw = await fetchSource({
        mode: "paste",
        text: parsed.data.text,
        title: parsed.data.title,
      });
    }
  } catch (err) {
    if (err instanceof UnsupportedSourceError) return { error: err.message, sourceId: null };
    if (err instanceof ColdSourceError) return { error: err.message, sourceId: null };
    return {
      error: err instanceof Error ? err.message : "Could not load the source.",
      sourceId: null,
    };
  }

  // Step 2 — extract structured material from the raw text. Failures here
  // (Claude unavailable, schema mismatch) surface to the form; we don't
  // half-persist a row with no extraction since the detail page would have
  // nothing to render.
  let extracted;
  try {
    const result = await extractFromSource(raw);
    extracted = result.extracted;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not extract from the source.",
      sourceId: null,
    };
  }

  // Step 3 — insert. Use the authed Supabase client (RLS enforces workspace
  // membership; no need for service-role here since the inserter is the
  // workspace owner/member).
  const supabase = await supabaseServer();
  const insertPayload = {
    workspace_id: ws.id,
    source_kind: raw.kind,
    source_url: raw.sourceUrl,
    file_path: raw.filePath,
    title: extracted.title ?? raw.title,
    extracted_summary: extracted.summary,
    extracted_quotes: extracted.quotes as unknown as Json,
    extracted_themes: extracted.themes as unknown as Json,
    extracted_facts: extracted.facts as unknown as Json,
    ingested_by: user.id,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("sources")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return { error: insertErr?.message ?? "Failed to save source.", sourceId: null };
  }

  revalidatePath("/sources");
  redirect(`/sources/${inserted.id}`);
}

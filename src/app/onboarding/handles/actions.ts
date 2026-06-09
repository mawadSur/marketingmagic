"use server";

import { z } from "zod";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { generateHandleCandidates } from "@/lib/handles/generate";
import { checkHandleCached, type CachedAvailability } from "@/lib/handles/check";
import { normalizeHandle, PLATFORM_ORDER } from "@/lib/handles/platforms";

// One candidate row the UI renders: the handle, its AI rationale, and the
// per-platform availability grid.
export interface HandleRow {
  handle: string;
  rationale: string;
  availability: CachedAvailability[];
}

export type FindHandlesState = {
  error: string | null;
  rows: HandleRow[];
  // Echo what we ran on so the form can show it / re-run.
  seed: string | null;
};

const generateSchema = z.object({
  seed: z.string().trim().max(60).optional(),
});

const checkSchema = z.object({
  handle: z.string().trim().min(1).max(40),
});

// Generate brandable candidates (AI, from the brand brief + optional seed word)
// and check each across all platforms, cache-first. This is the "magic button".
export async function findHandlesAction(
  _prev: FindHandlesState,
  formData: FormData,
): Promise<FindHandlesState> {
  const ws = await getActiveWorkspaceOrRedirect();

  const parsed = generateSchema.safeParse({ seed: formData.get("seed") || undefined });
  if (!parsed.success) {
    return { error: "Keep the brand word under 60 characters.", rows: [], seed: null };
  }
  const seedWord = parsed.data.seed?.trim() || undefined;

  try {
    // Pull the brand brief to ground the suggestions (best-effort; the finder
    // works off a bare seed word too).
    const supabase = await supabaseServer();
    const { data: brief } = await supabase
      .from("brand_briefs")
      .select("product_description, voice, target_audience")
      .eq("workspace_id", ws.id)
      .maybeSingle();

    const { candidates } = await generateHandleCandidates({
      seed: seedWord,
      productDescription: brief?.product_description ?? undefined,
      voice: brief?.voice ?? undefined,
      targetAudience: brief?.target_audience ?? undefined,
    });

    // Check availability for each candidate across all platforms (cache-first,
    // throttled). Sequential across candidates so we never burst N×8 probes at
    // once — each candidate's 8 platforms are already concurrency-capped inside.
    const rows: HandleRow[] = [];
    for (const c of candidates) {
      const availability = await checkHandleCached(c.handle, PLATFORM_ORDER);
      rows.push({ handle: c.handle, rationale: c.rationale, availability });
    }

    return { error: null, rows, seed: seedWord ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate handles.";
    return { error: message, rows: [], seed: seedWord ?? null };
  }
}

// Check ONE user-typed handle across all platforms (cache-first). Lets a user
// who already has a name in mind skip generation and just see the grid.
export async function checkHandleAction(
  _prev: FindHandlesState,
  formData: FormData,
): Promise<FindHandlesState> {
  await getActiveWorkspaceOrRedirect();

  const parsed = checkSchema.safeParse({ handle: formData.get("handle") });
  if (!parsed.success) {
    return { error: "Enter a handle (1–40 characters).", rows: [], seed: null };
  }
  const handle = normalizeHandle(parsed.data.handle);
  if (handle.length < 2) {
    return { error: "That handle is too short after cleanup.", rows: [], seed: null };
  }

  try {
    const availability = await checkHandleCached(handle, PLATFORM_ORDER);
    return {
      error: null,
      rows: [{ handle, rationale: "Your handle", availability }],
      seed: handle,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not check that handle.";
    return { error: message, rows: [], seed: handle };
  }
}

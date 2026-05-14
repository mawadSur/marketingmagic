import { supabaseService } from "@/lib/supabase/service";
import type { RejectionSignal } from "@/lib/plan/prompt";

// How far back to look for rejection feedback. Long enough to accumulate
// signal on low-velocity workspaces, short enough to stay relevant.
const LOOKBACK_DAYS = 30;

// Per-reason cap on example snippets we feed Claude. The full text might
// be 3000 chars (LinkedIn); only the lead matters for "don't sound like
// this" guidance.
const EXAMPLE_SNIPPET_CHARS = 200;
const MAX_EXAMPLES_PER_REASON = 3;

// Pulls recent rejected-with-reason posts and aggregates by reason.
// Mirrors collectThemeSignals in signals.ts: service-role client (we
// stitch across the approvals → posts join which the user-context
// client could in principle block on the approval row), bounded
// look-back, and a clean empty-state return.
export async function collectRejectionSignals(
  workspaceId: string,
): Promise<RejectionSignal[]> {
  const svc = supabaseService();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Single round-trip: pull recent rejection approvals (with reason) and
  // join the rejected post's text for the example snippet.
  const { data, error } = await svc
    .from("approvals")
    .select("reason, reason_note, created_at, posts!inner(text, workspace_id)")
    .eq("action", "rejected")
    .not("reason", "is", null)
    .gte("created_at", since)
    .eq("posts.workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error || !data) return [];

  type Row = {
    reason: RejectionSignal["reason"];
    reason_note: string | null;
    created_at: string;
    // Supabase returns the joined row as either an object or an array
    // depending on FK shape. We accept both shapes defensively.
    posts: { text: string } | { text: string }[] | null;
  };

  const byReason = new Map<RejectionSignal["reason"], RejectionSignal>();

  for (const row of data as unknown as Row[]) {
    if (!row.reason) continue;
    const entry =
      byReason.get(row.reason) ??
      ({ reason: row.reason, count: 0, examples: [] } as RejectionSignal);
    entry.count += 1;

    if (entry.examples.length < MAX_EXAMPLES_PER_REASON) {
      const post = Array.isArray(row.posts) ? row.posts[0] : row.posts;
      const text = post?.text ?? "";
      // Prefer the user's note when present (concrete reasoning) over a
      // raw post-text snippet (which Claude may not know the diagnosis of).
      const snippet = row.reason_note
        ? `[user note] ${row.reason_note}`
        : text.slice(0, EXAMPLE_SNIPPET_CHARS);
      if (snippet) entry.examples.push(snippet);
    }

    byReason.set(row.reason, entry);
  }

  // Order: off_voice first (most actionable in the voice-wedge phase),
  // then by count desc.
  return Array.from(byReason.values()).sort((a, b) => {
    if (a.reason === "off_voice" && b.reason !== "off_voice") return -1;
    if (b.reason === "off_voice" && a.reason !== "off_voice") return 1;
    return b.count - a.count;
  });
}

// TODO #0 (gap 2) — gather the user's OWN sent/published text as genuine-
// voice exemplars for the voice-evolution loop.
//
// =======================================================================
// Today the voice profile is seeded from pasted reference posts (extract.ts)
// and nudged AWAY from rejected drafts (the voice-evolution cron). Neither
// learns from what the user ACTUALLY publishes. This helper closes that gap:
// it pulls the workspace's genuinely-human-authored outbound text so the
// evolution cron can converge the profile TOWARD how the user really writes.
//
// SOURCES (genuine voice only — never AI-auto-sent text, to avoid an echo
// chamber where the AI relearns its own style):
//
//   1. Published posts — posts.status='posted'. These are the user's own
//      outbound content; they were approved/written by a human before they
//      went out. The richest, highest-volume genuine-voice signal.
//
//   2. Manually-sent inbox replies — the synthetic posts rows created by the
//      manual reply send path (sendReplyViaChannel), distinguished from the
//      autonomous auto-reply path by a human approvals row (action='approved'
//      with a non-null user_id). The auto-reply path attributes to
//      auto_reply_log instead and inserts NO approvals row, so it is excluded.
//
// PURE-ISH at the edges: all DB access goes through the passed-in service
// client; the filtering/dedup/clamp logic is pure and unit-testable via
// foldSentExemplars().
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

type ServiceClient = SupabaseClient<Database>;

// Keep the exemplar set bounded — extract-style budgets. The evolution cron
// only needs a representative sample of the genuine voice, not the archive.
export const MAX_SENT_EXEMPLARS = 25;
export const MAX_EXEMPLAR_CHARS = 600; // per item; long-form gets truncated
export const MIN_EXEMPLAR_CHARS = 12; // skip one-word "thanks!" noise

// One genuine-voice exemplar with its provenance, for prompt context + audit.
export interface SentExemplar {
  text: string;
  source: "published_post" | "sent_reply";
  at: string; // ISO timestamp the text went out
}

// Pure: clean, filter, dedupe, sort newest-first, and clamp a raw exemplar
// list. Exported so tests can exercise the folding logic without a DB.
export function foldSentExemplars(raw: SentExemplar[]): SentExemplar[] {
  const seen = new Set<string>();
  const cleaned: SentExemplar[] = [];
  for (const ex of raw) {
    const text = (ex.text ?? "").trim();
    if (text.length < MIN_EXEMPLAR_CHARS) continue;
    const key = text.toLowerCase().slice(0, 200);
    if (seen.has(key)) continue; // dedupe near-identical reposts/variants
    seen.add(key);
    cleaned.push({
      text: text.length > MAX_EXEMPLAR_CHARS ? text.slice(0, MAX_EXEMPLAR_CHARS) : text,
      source: ex.source,
      at: ex.at,
    });
  }
  // Newest first — recent writing reflects the current voice best.
  cleaned.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return cleaned.slice(0, MAX_SENT_EXEMPLARS);
}

// Load genuine-voice exemplars for a workspace since `since` (ISO). Always
// resolves to an array (empty on no data / error) — the caller treats this
// as a best-effort signal and never fails the run on it.
export async function loadSentExemplars(
  svc: ServiceClient,
  workspaceId: string,
  since: string,
): Promise<SentExemplar[]> {
  const raw: SentExemplar[] = [];

  // 1. Published posts. We over-fetch (2x cap) before the pure fold trims +
  // dedupes, so reposted variants don't crowd out distinct voice samples.
  const { data: posts } = await svc
    .from("posts")
    .select("text, posted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since)
    .order("posted_at", { ascending: false })
    .limit(MAX_SENT_EXEMPLARS * 2);
  for (const p of posts ?? []) {
    const text = (p as { text?: string }).text ?? "";
    const at = (p as { posted_at?: string }).posted_at ?? since;
    if (text) raw.push({ text, source: "published_post", at });
  }

  // 2. Manually-sent inbox replies. These are synthetic posts rows carrying a
  // human approvals row (action='approved', user_id not null). We join from
  // approvals → posts so we only pick up human-sent text, never the AI's
  // auto-sent replies (which have no approvals row). Best-effort; the embedded
  // resource select degrades to nothing if the relationship can't resolve.
  const { data: humanApprovals } = await svc
    .from("approvals")
    .select("created_at, user_id, posts!inner(text, workspace_id, status)")
    .eq("action", "approved")
    .not("user_id", "is", null)
    .gte("created_at", since)
    .eq("posts.workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(MAX_SENT_EXEMPLARS * 2);
  for (const a of humanApprovals ?? []) {
    const post = (a as { posts?: { text?: string } | { text?: string }[] }).posts;
    const resolved = Array.isArray(post) ? post[0] : post;
    const text = resolved?.text ?? "";
    const at = (a as { created_at?: string }).created_at ?? since;
    if (text) raw.push({ text, source: "sent_reply", at });
  }

  return foldSentExemplars(raw);
}

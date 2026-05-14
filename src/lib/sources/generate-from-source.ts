// Source-anchored plan generation.
//
// This is intentionally a thin wrapper around generatePlan() — the only
// difference between a normal plan and a source-anchored plan is that the
// latter passes a `source` field into PlanGenInputs, which lights up the
// "## Source material" block in the planner's system prompt (see
// src/lib/plan/prompt.ts:sourceBlock).
//
// Why a wrapper and not inline at the call site:
//   - Keeps the caller (the /sources/[id] action) small — it just shapes
//     a SourceRow into a SourceContext and hands off.
//   - Lets us evolve the source→plan integration (cluster size policy,
//     theme-tag merging) in one place rather than touching the larger
//     plans/new server action and risking conflicts with the Discord /
//     memberships agents.
//   - The Phase-2 cross-channel adaptation is preserved exactly: a source-
//     anchored plan still emits `ideas[]` with per-channel variants, still
//     respects voice_score/low_confidence, still goes through the same
//     skip/idea_id fan-out logic in the persistence layer.

import type { Database, ExtractedQuote, ExtractedFact } from "@/lib/db/types";
import { generatePlan, type PlanGenResult } from "@/lib/plan/generate";
import type {
  PlanGenInputs,
  SourceContext,
  ThemeSignal,
  RejectionSignal,
} from "@/lib/plan/prompt";
import type { SavedPattern } from "@/lib/explain/playbook";
import type { ChannelId } from "@/lib/channels/registry";

type SourceRow = Database["public"]["Tables"]["sources"]["Row"];

export interface GenerateFromSourceInputs {
  brief: Database["public"]["Tables"]["brand_briefs"]["Row"];
  source: SourceRow;
  channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }>;
  weeks: number;
  startDate: Date;
  winners?: ThemeSignal[];
  losers?: ThemeSignal[];
  rejections?: RejectionSignal[];
  savedPatterns?: SavedPattern[];
  retryNote?: string;
}

// Reshape a source row's jsonb columns into the strongly-typed SourceContext
// the planner expects. The columns are jsonb (loose) on the way in; the
// planner needs them narrowed. We tolerate malformed rows by filtering
// (rather than throwing) because a future migration shouldn't break old
// rows in-place — better to ship a cluster with fewer quotes than to 500.
export function sourceContextFromRow(row: SourceRow): SourceContext {
  const themes = asStringArray(row.extracted_themes);
  const quotes = asExtractedQuotes(row.extracted_quotes);
  const facts = asExtractedFacts(row.extracted_facts);
  return {
    title: row.title ?? "Untitled source",
    summary: row.extracted_summary ?? "",
    themes,
    quotes,
    facts,
    sourceUrl: row.source_url,
  };
}

export async function generateFromSource(
  inputs: GenerateFromSourceInputs,
): Promise<PlanGenResult> {
  const source = sourceContextFromRow(inputs.source);
  const planInputs: PlanGenInputs = {
    brief: inputs.brief,
    channelMix: inputs.channelMix,
    weeks: inputs.weeks,
    startDate: inputs.startDate,
    winners: inputs.winners,
    losers: inputs.losers,
    rejections: inputs.rejections,
    savedPatterns: inputs.savedPatterns,
    retryNote: inputs.retryNote,
    source,
  };
  return generatePlan(planInputs);
}

// ─── Narrowing helpers ──────────────────────────────────────────────

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out;
}

function asExtractedQuotes(value: unknown): ExtractedQuote[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedQuote[] = [];
  for (const v of value) {
    if (v && typeof v === "object" && "text" in v && typeof (v as { text: unknown }).text === "string") {
      const obj = v as { text: string; speaker?: unknown };
      const q: ExtractedQuote = { text: obj.text };
      if (typeof obj.speaker === "string" && obj.speaker.trim().length > 0) {
        q.speaker = obj.speaker;
      }
      out.push(q);
    }
  }
  return out;
}

function asExtractedFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedFact[] = [];
  for (const v of value) {
    if (v && typeof v === "object" && "text" in v && typeof (v as { text: unknown }).text === "string") {
      const obj = v as { text: string; context?: unknown };
      const f: ExtractedFact = { text: obj.text };
      if (typeof obj.context === "string" && obj.context.trim().length > 0) {
        f.context = obj.context;
      }
      out.push(f);
    }
  }
  return out;
}

import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Source schemas (Phase 2.5 — Source-to-Posts Ingestion)
// ─────────────────────────────────────────────────────────────
//
// Two adjacent shapes live here:
//
//   1. RawSource — what `src/lib/sources/fetch.ts` returns after pulling the
//      bytes for an input (URL/file/paste) and converting them to a single
//      plain-text blob. Has just enough metadata to label the source
//      (title, kind, where-it-came-from) so downstream extraction is purely
//      text→structured.
//
//   2. ExtractedSource — what `src/lib/sources/extract-claude.ts` returns
//      after Claude reads the raw text. This is what gets persisted to the
//      `sources.extracted_*` columns and fed back into the planner when we
//      generate the cluster.
//
// We keep them separate so a failed extraction doesn't lose the fetched
// text — RawSource is also useful for letting the user re-trigger extraction
// without re-fetching the underlying file.

// Matches the CHECK constraint on sources.source_kind (migration 009).
export const sourceKindSchema = z.enum([
  "html",
  "youtube",
  "podcast",
  "pdf",
  "transcript",
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// Input the user submits. URL OR file OR pasted transcript text.
// Validation is performed in the server action — the schema here is the
// canonical narrowed shape we hand to fetch().
export const sourceInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("url"),
    url: z.string().url(),
    // Optional override — when the user wants to label the source themselves
    // rather than relying on Claude's auto-extracted title.
    title: z.string().trim().max(280).optional(),
  }),
  z.object({
    mode: z.literal("paste"),
    text: z.string().trim().min(50, "Paste at least 50 characters."),
    title: z.string().trim().min(1).max(280),
  }),
]);
export type SourceInput = z.infer<typeof sourceInputSchema>;

// Result of the fetch/transcribe step. Always text-like — we don't carry
// HTML or PDF bytes downstream.
export const rawSourceSchema = z.object({
  kind: sourceKindSchema,
  text: z.string().min(1),
  title: z.string().trim().min(1).max(280),
  sourceUrl: z.string().url().nullable(),
  // Set when we stored the original upload in Supabase Storage (PDF/audio).
  // Today we don't actually upload from the browser — paste is the V1 entry
  // point for transcripts — but the column exists so a future Founder-Mode
  // / file-upload path can populate it.
  filePath: z.string().nullable(),
});
export type RawSource = z.infer<typeof rawSourceSchema>;

// Per-quote shape Claude returns. Keep speakers optional — most HTML sources
// won't have an attributable speaker (it's just "the page").
export const extractedQuoteSchema = z.object({
  text: z.string().trim().min(1).max(500),
  speaker: z.string().trim().min(1).max(120).optional(),
});
export type ExtractedQuote = z.infer<typeof extractedQuoteSchema>;

// Per-fact shape. `context` is a short pointer ("paragraph 3", "00:14:22")
// so a future "view in source" UI can deep-link without us re-running the
// extraction.
export const extractedFactSchema = z.object({
  text: z.string().trim().min(1).max(500),
  context: z.string().trim().min(1).max(280).optional(),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

// What Claude returns from extractFromSource(). Mirrors the
// sources.extracted_* columns 1:1.
export const extractedSourceSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  themes: z.array(z.string().trim().min(1).max(60)).max(20),
  quotes: z.array(extractedQuoteSchema).max(15),
  facts: z.array(extractedFactSchema).max(20),
  // Auto-extracted display title (used when the user didn't override it).
  title: z.string().trim().min(1).max(280).optional(),
});
export type ExtractedSource = z.infer<typeof extractedSourceSchema>;

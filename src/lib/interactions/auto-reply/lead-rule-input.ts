// Bet 4 — comment→DM lead capture: SETTINGS-BOUNDARY validation for the
// lead_keyword_rule editor.
//
// =======================================================================
// PURE INPUT VALIDATION (zod). No DB, no network.
// =======================================================================
// The settings form collects a keyword rule as loose, human-entered strings:
//   * keywords as ONE comma-separated string ("pricing, demo, how much"),
//   * a link to DM back,
//   * an optional DM message template,
//   * an optional dollar value (entered in DOLLARS, stored as cents).
//
// This module is the boundary that turns that raw form input into either a
// clean LeadKeywordRule to persist, or a structured field-error map to show.
//
// CLEAR SEMANTICS: an entirely EMPTY form (no keywords AND no link) is a valid
// request meaning "clear the rule" → parse() returns { ok: true, rule: null },
// and the action writes NULL (the comment→DM path then no-ops, by design). A
// PARTIAL form (e.g. keywords but no link) is an ERROR — we never persist a
// half-built rule that could behave surprisingly.
//
// The acceptance bar mirrors lead-capture.ts/parseLeadKeywordRule exactly so a
// rule that validates here always re-parses to a usable rule at send time:
// keywords are trimmed and must be >= 2 chars, the link must be non-empty, and
// valueCents is a non-negative integer. Anything weaker is rejected here rather
// than silently dropped at send time.
// =======================================================================

import { z } from "zod";
import type { LeadKeywordRule } from "./lead-capture";

// Ceilings: keep the persisted blob small and the DM body within the platform
// limit. The DM body ceiling (3000) is enforced again at build time, but we cap
// the stored template here so the JSONB stays bounded.
export const LEAD_RULE_MAX_KEYWORDS = 25;
export const LEAD_RULE_MAX_KEYWORD_LEN = 60;
export const LEAD_RULE_MAX_LINK_LEN = 2000;
export const LEAD_RULE_MAX_MESSAGE_LEN = 3000;
// Sanity ceiling on attributed lead value: $1,000,000 (in cents). Guards
// against a fat-fingered entry inflating outcome reporting.
export const LEAD_RULE_MAX_VALUE_CENTS = 100_000_000;

// Raw shape coming off the settings form. Everything is a string (or empty) —
// the editor never pre-coerces. `clear` is an explicit signal for an empty
// submit, but we also treat an all-blank form as a clear.
export const leadRuleFormSchema = z.object({
  // Comma-separated keywords, e.g. "pricing, demo, how much".
  keywords: z.string().max(2000).optional().default(""),
  link: z.string().max(LEAD_RULE_MAX_LINK_LEN).optional().default(""),
  message: z.string().max(LEAD_RULE_MAX_MESSAGE_LEN).optional().default(""),
  // Dollar value as typed (e.g. "25" or "25.50"). Optional/blank → no value.
  valueDollars: z.string().max(20).optional().default(""),
});

export type LeadRuleFormInput = z.input<typeof leadRuleFormSchema>;

export type LeadRuleParseResult =
  | { ok: true; rule: LeadKeywordRule | null }
  | { ok: false; errors: Record<string, string> };

// Split a comma-separated string into trimmed, de-duplicated, >=2-char
// keywords. Mirrors parseLeadKeywordRule's keyword acceptance so what validates
// here is exactly what survives at send time.
export function splitKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const k = part.trim();
    if (k.length < 2) continue;
    const dedupeKey = k.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(k);
  }
  return out;
}

// Parse + validate raw settings-form input into a persistable rule, a clear
// (null), or a field-error map. The single boundary the action calls.
export function parseLeadRuleForm(raw: unknown): LeadRuleParseResult {
  const parsed = leadRuleFormSchema.safeParse(raw);
  if (!parsed.success) {
    // Map zod's flattened field errors to a flat {field: firstMessage} map.
    const flat = parsed.error.flatten().fieldErrors;
    const errors: Record<string, string> = {};
    for (const [field, msgs] of Object.entries(flat)) {
      if (msgs && msgs.length > 0) errors[field] = msgs[0];
    }
    return { ok: false, errors };
  }

  const form = parsed.data;
  const keywords = splitKeywords(form.keywords);
  const link = form.link.trim();
  const message = form.message.trim();
  const valueRaw = form.valueDollars.trim();

  // ── Clear: an entirely empty form means "remove the rule". ────────────
  const allBlank =
    keywords.length === 0 && link.length === 0 && message.length === 0 && valueRaw.length === 0;
  if (allBlank) return { ok: true, rule: null };

  // ── Otherwise validate a full rule (never persist a partial one). ─────
  const errors: Record<string, string> = {};

  if (keywords.length === 0) {
    errors.keywords =
      "Add at least one keyword (2+ characters, comma-separated).";
  } else if (keywords.length > LEAD_RULE_MAX_KEYWORDS) {
    errors.keywords = `Too many keywords (max ${LEAD_RULE_MAX_KEYWORDS}).`;
  } else if (keywords.some((k) => k.length > LEAD_RULE_MAX_KEYWORD_LEN)) {
    errors.keywords = `Each keyword must be ${LEAD_RULE_MAX_KEYWORD_LEN} characters or fewer.`;
  }

  if (link.length === 0) {
    errors.link = "Add the link to DM back (lead magnet / booking page).";
  } else if (!isHttpUrl(link)) {
    errors.link = "Link must be a valid http(s) URL.";
  }

  let valueCents: number | undefined;
  if (valueRaw.length > 0) {
    const dollars = Number(valueRaw);
    if (!Number.isFinite(dollars) || dollars < 0) {
      errors.valueDollars = "Value must be a non-negative number.";
    } else {
      const cents = Math.round(dollars * 100);
      if (cents > LEAD_RULE_MAX_VALUE_CENTS) {
        errors.valueDollars = "Value is too large.";
      } else if (cents > 0) {
        valueCents = cents;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const rule: LeadKeywordRule = {
    keywords,
    link,
    ...(valueCents !== undefined ? { valueCents } : {}),
    ...(message.length > 0 ? { message } : {}),
  };
  return { ok: true, rule };
}

// Strict-ish URL guard: must parse AND be http/https. (zod's .url() accepts
// any protocol; we only ever DM an http(s) link.)
function isHttpUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

// Render a stored rule back into the flat string form the editor displays.
// Inverse of parseLeadRuleForm for the happy path (keywords joined by ", ",
// cents shown as a plain dollar number). Used to pre-fill the editor.
export function leadRuleToForm(
  rule: LeadKeywordRule | null,
): { keywords: string; link: string; message: string; valueDollars: string } {
  if (!rule) return { keywords: "", link: "", message: "", valueDollars: "" };
  return {
    keywords: rule.keywords.join(", "),
    link: rule.link,
    message: rule.message ?? "",
    valueDollars:
      rule.valueCents && rule.valueCents > 0
        ? String(rule.valueCents / 100)
        : "",
  };
}

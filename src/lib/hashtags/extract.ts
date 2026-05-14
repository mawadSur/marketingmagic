// Phase 6.10 — hashtag extraction from free-form post body.
//
// Single regex with explicit normalization: lowercase, deduplicated,
// no leading '#'. We intentionally don't match Unicode letter classes
// — every supported channel's tag implementation is ASCII-letter +
// digit + underscore. Matching wider would let us record tags the
// platforms themselves would silently drop.
//
// Examples:
//   "shipping #BuildInPublic with #buildinpublic & #2024-recap"
//   → ["buildinpublic", "2024"]
//
// The "#2024-recap" case shows the right thing happens: the hyphen
// terminates the tag (consistent with every social platform), so we
// keep "2024" and drop "-recap". If we ever need to keep punctuation,
// it'll be a per-channel concern handled at the formatter, not here.

const TAG_RE = /(?:^|\s)#([A-Za-z0-9_]+)/g;

const MAX_TAG_LENGTH = 100; // matches CHECK in migration 014

export function extractHashtags(text: string): string[] {
  if (!text || text.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Re-create regex per call to reset lastIndex — using a module-level
  // /g RegExp across re-entrant calls is a classic stateful-iterator
  // footgun.
  const re = new RegExp(TAG_RE.source, TAG_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalized = m[1].toLowerCase();
    if (normalized.length === 0 || normalized.length > MAX_TAG_LENGTH) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

// Apply a user-toggled set of tags to a draft text. Idempotent:
// - removes every existing #tag in the draft
// - appends the kept tags as a single trailing block separated from the
//   body by a blank line
// We do not try to inline tags into the prose — that's an editing
// concern. Trailing block is the universal pattern across channels.
//
// Used by the /queue setHashtagsAction.
export function applyHashtagsToText(draft: string, tags: string[]): string {
  // Strip every existing hashtag from the body.
  const stripped = draft
    .replace(/(?:(?:^|\s)#[A-Za-z0-9_]+)/g, (match) => (match.startsWith(" ") ? "" : ""))
    .replace(/[ \t]+\n/g, "\n") // tidy trailing whitespace
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
  const normalized = tags
    .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
    .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH);
  if (normalized.length === 0) return stripped;
  const tagBlock = normalized.map((t) => `#${t}`).join(" ");
  if (stripped.length === 0) return tagBlock;
  return `${stripped}\n\n${tagBlock}`;
}

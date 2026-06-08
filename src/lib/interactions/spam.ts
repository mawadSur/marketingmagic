// TODO #0 (gap 1) — Inbox spam classification.
//
// =======================================================================
// PURE, CHEAP-FIRST SPAM HEURISTICS. No DB, no network, no clock reads
// except what's passed in. The optional Claude pass for the borderline
// band lives in classifyBorderlineWithClaude() and is the ONLY thing in
// this module that touches the network — the heuristic core is what the
// poll loop runs on every inbound, O(1)-ish, and is exhaustively unit-
// testable. That separation matters: false-positive spam-ignore drops a
// real customer reply, so the bar must be auditable and conservative.
// =======================================================================
//
// MODEL: a 0-100 spam_score where HIGHER = more spammy (the inverse of
// priority_score). We bucket it into three verdicts:
//
//   * 'ham'        — clearly worth answering. We NEVER auto-ignore ham.
//   * 'spam'       — clearly junk (>= SPAM_THRESHOLD). Auto-ignore candidate.
//   * 'borderline' — in the grey band [HAM_CEILING, SPAM_THRESHOLD). NEVER
//                    auto-ignored on heuristics alone; surfaced for review,
//                    and optionally escalated to Claude when the workspace
//                    has opted into spam_ignore_use_claude.
//
// CONSERVATIVE BY CONSTRUCTION: the auto-ignore action only fires on a
// 'spam' verdict, and only the spam-ignore orchestrator's gate (trust +
// mode + kill switch) decides whether that verdict actually flips a row.
// This module just produces the signal.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";

const MODEL = "claude-opus-4-8";

// ── Verdict bands ────────────────────────────────────────────────────────
//
// HAM_CEILING: at or below this score we treat the message as ham — never a
//   spam-ignore candidate. Deliberately low so anything with even mild spam
//   signal escapes the ham bucket into 'borderline' (review), not into a
//   silent auto-ignore.
// SPAM_THRESHOLD: at or above this we call it spam. Set HIGH (conservative):
//   a message needs multiple independent junk signals to clear the bar, so a
//   single unlucky heuristic can never auto-ignore a real reply.
export const HAM_CEILING = 30;
export const SPAM_THRESHOLD = 70;

export type SpamVerdict = "ham" | "spam" | "borderline";

export interface SpamSignal {
  // Short machine-readable id of the signal that fired (audited).
  key: string;
  // Points this signal contributed to the spam score.
  weight: number;
  // Human-readable note for the audit log / review UI.
  note: string;
}

export interface SpamClassification {
  // 0-100, higher = spammier. Clamped.
  score: number;
  verdict: SpamVerdict;
  // The heuristic signals that fired, for auditability.
  signals: SpamSignal[];
}

// ── Heuristic weights (max contribution each) ─────────────────────────────
//
// Tuned so that NO single signal can reach SPAM_THRESHOLD on its own — spam
// requires a confluence. e.g. "has a link" alone is +18, well under 70: a
// customer linking their repo is not spam.
export const W_MULTIPLE_LINKS = 35; // 2+ URLs — classic link-spam.
export const W_SINGLE_LINK = 18; // exactly one URL — mild signal only.
export const W_KNOWN_PATTERN = 40; // matched a known crypto/giveaway/DM-me phrase.
export const W_REPETITION = 25; // same token/char repeated unnaturally.
export const W_ALL_CAPS = 12; // shouty body (>= 60% caps over a long body).
export const W_MENTION_STUFFING = 22; // 4+ @mentions — engagement-bait/tag-spam.
export const W_EMOJI_FLOOD = 12; // emoji-dense, low-text.
export const W_CONTACT_SOLICIT = 20; // "DM me", "check my bio", "telegram", etc.
export const W_GIBBERISH = 18; // very low alpha ratio / random-looking.

// Known junk phrases. Case-insensitive substring match. Kept intentionally
// tight + high-precision: each entry should be something a real customer
// reply almost never contains verbatim. Broadening this list is a precision
// tradeoff — prefer the borderline→review path over adding loose phrases.
const KNOWN_SPAM_PATTERNS: ReadonlyArray<{ re: RegExp; note: string }> = [
  { re: /\bfree\s+(crypto|bitcoin|btc|eth|nft|airdrop)\b/i, note: "free-crypto offer" },
  { re: /\b(double|10x|100x)\s+your\s+(money|crypto|investment)\b/i, note: "money-multiplier scam" },
  { re: /\bguaranteed\s+(profit|returns|income)\b/i, note: "guaranteed-returns claim" },
  { re: /\bclick\s+(the\s+)?link\s+in\s+(my\s+)?bio\b/i, note: "link-in-bio bait" },
  { re: /\bdm\s+me\s+(for|to)\b/i, note: "DM-me solicitation" },
  { re: /\b(join|message|contact)\s+me\s+on\s+(telegram|whatsapp|signal)\b/i, note: "off-platform contact bait" },
  { re: /\bt\.me\/[a-z0-9_]+/i, note: "telegram invite link" },
  { re: /\b(work|earn)\s+from\s+home\b.*\$\d/i, note: "work-from-home income bait" },
  { re: /\b(seo|backlinks|followers|likes)\s+(service|services|cheap|for\s+sale)\b/i, note: "growth-service spam" },
  { re: /\bcongratulations[!,. ].*\b(won|winner|selected)\b/i, note: "you-won scam" },
  { re: /\binvest(ing)?\s+(opportunity|expert|manager)\b/i, note: "investment-pitch bait" },
];

// "Contact me off-platform" / engagement-bait soft phrases. Lower weight
// than the high-precision scam patterns above, but a useful borderline nudge.
const CONTACT_SOLICIT_RE =
  /\b(check\s+my\s+(bio|profile)|hit\s+me\s+up|inbox\s+me|see\s+my\s+pinned)\b/i;

const URL_RE = /https?:\/\/[^\s]+|\bwww\.[^\s]+/gi;
const MENTION_RE = /@[\w.\-]+/g;
// Rough emoji matcher — covers the common pictographic ranges. We only need a
// count, not perfect Unicode segmentation.
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

function countMatches(body: string, re: RegExp): number {
  const m = body.match(re);
  return m ? m.length : 0;
}

// Detects an unnatural single-token/char repetition (e.g. "buy buy buy buy"
// or "🚀🚀🚀🚀🚀"). Returns true when one token makes up an outsized share of
// a non-trivial body.
function hasUnnaturalRepetition(body: string): boolean {
  const tokens = body.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length >= 6) {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let max = 0;
    for (const c of counts.values()) max = Math.max(max, c);
    // One token repeated >= 40% of a >=6-word message is unnatural.
    if (max / tokens.length >= 0.4) return true;
  }
  // Same char run, e.g. "!!!!!!!!" or "aaaaaaaa".
  if (/(.)\1{7,}/.test(body)) return true;
  return false;
}

// All-caps shouting over a body long enough that caps are a choice, not an
// acronym. We ignore short bodies (acronyms, ticker symbols).
function isShouting(body: string): boolean {
  const letters = body.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 20) return false;
  const upper = body.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.6;
}

// Low alphabetic ratio over a non-trivial body suggests link/symbol gibberish.
function isGibberish(body: string): boolean {
  const stripped = body.replace(URL_RE, " "); // don't penalise a legit URL's chars
  const compact = stripped.replace(/\s+/g, "");
  if (compact.length < 24) return false;
  const alpha = compact.replace(/[^a-zA-Z]/g, "").length;
  return alpha / compact.length < 0.45;
}

// ── The pure heuristic classifier ─────────────────────────────────────────
//
// Always resolves to a SpamClassification; never throws. Empty / whitespace
// bodies score 0 (ham) — we never auto-ignore a row we can't read.
export function classifySpamHeuristic(body: string): SpamClassification {
  const signals: SpamSignal[] = [];
  const text = (body ?? "").trim();
  if (text.length === 0) {
    return { score: 0, verdict: "ham", signals };
  }

  const add = (key: string, weight: number, note: string) => {
    signals.push({ key, weight, note });
  };

  // Links.
  const linkCount = countMatches(text, URL_RE);
  if (linkCount >= 2) add("multiple_links", W_MULTIPLE_LINKS, `${linkCount} URLs`);
  else if (linkCount === 1) add("single_link", W_SINGLE_LINK, "1 URL");

  // Known high-precision junk phrases.
  for (const pat of KNOWN_SPAM_PATTERNS) {
    if (pat.re.test(text)) {
      add("known_pattern", W_KNOWN_PATTERN, pat.note);
      break; // one match is enough; don't stack multiple pattern hits.
    }
  }

  // Soft off-platform contact solicitation.
  if (CONTACT_SOLICIT_RE.test(text)) {
    add("contact_solicit", W_CONTACT_SOLICIT, "off-platform contact solicitation");
  }

  // Repetition.
  if (hasUnnaturalRepetition(text)) {
    add("repetition", W_REPETITION, "unnatural token/char repetition");
  }

  // Shouting.
  if (isShouting(text)) add("all_caps", W_ALL_CAPS, "predominantly uppercase");

  // Mention stuffing.
  const mentionCount = countMatches(text, MENTION_RE);
  if (mentionCount >= 4) {
    add("mention_stuffing", W_MENTION_STUFFING, `${mentionCount} @mentions`);
  }

  // Emoji flood (emoji-dense, low text).
  const emojiCount = countMatches(text, EMOJI_RE);
  const wordCount = text.split(/\s+/).filter((t) => t.length > 0).length;
  if (emojiCount >= 5 && emojiCount >= wordCount) {
    add("emoji_flood", W_EMOJI_FLOOD, `${emojiCount} emoji, ${wordCount} words`);
  }

  // Gibberish.
  if (isGibberish(text)) add("gibberish", W_GIBBERISH, "low alphabetic ratio");

  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { score, verdict: verdictForScore(score), signals };
}

// Map a 0-100 spam score onto the three-band verdict. Pure + exported so the
// orchestrator, tests, and the optional Claude path all agree on the bands.
export function verdictForScore(score: number): SpamVerdict {
  if (score >= SPAM_THRESHOLD) return "spam";
  if (score <= HAM_CEILING) return "ham";
  return "borderline";
}

// ── Optional Claude pass for the borderline band ──────────────────────────
//
// Only ever called for a 'borderline' heuristic verdict on workspaces that
// opted into spam_ignore_use_claude. It returns a refined classification.
// FAIL-OPEN TOWARD HAM: any error / ambiguous tool output resolves to 'ham'
// (do NOT ignore) — never to spam. A model hiccup must never silently drop a
// customer reply.
let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

const SPAM_TOOL = {
  name: "classify_spam",
  description:
    "Classify whether an inbound social-media reply/comment is spam (junk we should " +
    "auto-ignore) or a genuine message worth a human's attention. Call exactly once. " +
    "Bias toward 'genuine' when uncertain — a wrongly-ignored real customer is far " +
    "worse than a spam message slipping through to the inbox.",
  input_schema: {
    type: "object",
    required: ["is_spam", "confidence", "reason"],
    properties: {
      is_spam: {
        type: "boolean",
        description: "true only if this is clearly junk a human would not want to see.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "0-1 confidence in the is_spam call.",
      },
      reason: {
        type: "string",
        maxLength: 280,
        description: "One short sentence justifying the call (audited).",
      },
    },
    additionalProperties: false,
  },
} as const;

// Claude must clear BOTH a spam verdict AND this confidence floor before we
// upgrade a borderline heuristic result to 'spam'. Conservative: a low-
// confidence spam call stays 'borderline' (review), not auto-ignored.
export const CLAUDE_SPAM_CONFIDENCE_MIN = 0.85;

export interface ClaudeSpamResult {
  classification: SpamClassification;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export async function classifyBorderlineWithClaude(
  body: string,
  heuristic: SpamClassification,
): Promise<ClaudeSpamResult> {
  // Defensive: this is only meant for the borderline band. For anything else,
  // return the heuristic untouched — we never spend a Claude call to second-
  // guess a clear ham/spam heuristic verdict.
  if (heuristic.verdict !== "borderline") {
    return { classification: heuristic, usage: null };
  }

  const system = [
    "You are a spam filter for a social-media inbox.",
    "You will see one inbound reply/comment. Decide if it is spam (junk to auto-ignore)",
    "or a genuine message worth a human's attention.",
    "",
    "Genuine includes: questions, feedback, criticism, jokes, fans, leads, support",
    "requests — anything a real person plausibly meant for the brand. Spam includes:",
    "crypto/giveaway scams, off-platform contact bait, SEO/follower-selling, mass tag",
    "stuffing, gibberish, and copy-paste promotion unrelated to the brand.",
    "",
    "Bias toward 'genuine' when uncertain. Call classify_spam exactly once.",
  ].join("\n");

  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 512,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [SPAM_TOOL],
      tool_choice: { type: "tool", name: "classify_spam" },
      messages: [{ role: "user", content: `Inbound message:\n${body.slice(0, 2000)}` }],
    });

    const toolUse = resp.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "classify_spam") {
      return {
        classification: failOpenToHam(heuristic, "claude returned no tool call"),
        usage: null,
      };
    }
    const raw = toolUse.input as { is_spam?: unknown; confidence?: unknown; reason?: unknown };
    const isSpam = raw.is_spam === true;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
    const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 280) : "";

    const usage = {
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
    };

    // Upgrade to spam ONLY on a confident spam call. Otherwise resolve to ham
    // (do not ignore) — borderline + a hesitant model is not enough to drop a
    // message. We fold the Claude reason into the audited signals either way.
    if (isSpam && confidence >= CLAUDE_SPAM_CONFIDENCE_MIN) {
      return {
        classification: {
          score: Math.max(heuristic.score, SPAM_THRESHOLD),
          verdict: "spam",
          signals: [
            ...heuristic.signals,
            {
              key: "claude_spam",
              weight: 0,
              note: `claude: ${reason} (conf ${confidence.toFixed(2)})`,
            },
          ],
        },
        usage,
      };
    }
    return {
      classification: {
        score: heuristic.score,
        verdict: "ham",
        signals: [
          ...heuristic.signals,
          {
            key: "claude_ham",
            weight: 0,
            note: `claude: not spam — ${reason} (conf ${confidence.toFixed(2)})`,
          },
        ],
      },
      usage,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return { classification: failOpenToHam(heuristic, `claude error: ${msg}`), usage: null };
  }
}

function failOpenToHam(heuristic: SpamClassification, note: string): SpamClassification {
  return {
    score: heuristic.score,
    verdict: "ham",
    signals: [...heuristic.signals, { key: "claude_failopen", weight: 0, note }],
  };
}

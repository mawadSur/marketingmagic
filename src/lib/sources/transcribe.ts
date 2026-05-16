// Hosted Whisper transcription via Groq.
//
// V1 scope: this module is reachable but not wired to any user-facing
// path. The flow is one call: send audio bytes + model name → get back
// a transcript string. Groq exposes the OpenAI-compatible audio API at
// https://api.groq.com/openai/v1/audio/transcriptions, so we hit it with
// plain fetch + multipart form data and avoid pulling another SDK.
//
// Graceful degrade: when GROQ_API_KEY is unset, `transcribeAudio()`
// throws TranscriptionUnavailableError. The /sources/new flow translates
// that to a friendly "Paste the transcript instead" message — the audio/
// video kinds remain selectable but the action returns early.
//
// When wired up (Phase 2.6 Founder Mode + Phase 3 video captions both
// share this infra), the caller passes:
//   - audio bytes (mp3/m4a/wav/webm — Groq accepts all)
//   - filename hint (for content-type sniffing on Groq's side)
//   - optional model override (default: whisper-large-v3-turbo for speed)
//
// We don't expose this from /sources/new in V1 because we don't have a
// file-upload UI path here yet — paste-transcript is the V1 entry point.
// See tasks.md Phase 2.6 (Founder Mode) for the audio path that will use
// this helper.

import { serverEnv } from "@/lib/env";

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

export class TranscriptionUnavailableError extends Error {
  constructor() {
    super(
      "Audio transcription isn't configured. Paste the transcript text instead, or ask the operator to set GROQ_API_KEY.",
    );
    this.name = "TranscriptionUnavailableError";
  }
}

export class TranscriptionError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface TranscribeOptions {
  filename: string;
  // MIME hint. Groq's API sniffs from filename too, but passing both keeps
  // the upload safe across edge cases (e.g. .webm with audio/webm content).
  contentType?: string;
  model?: string;
  // When true, request verbose_json with word-level timestamps so callers
  // can surface jargon hints. Costs slightly more bytes on the wire but
  // no extra latency. Defaults to false to preserve the prior shape for
  // callers that only need the text.
  verbose?: boolean;
}

// Phase 2.6 — jargon hint shape. A "low confidence" word is one whose
// containing Whisper segment had an avg_logprob below LOW_CONF_LOGPROB
// (≈ exp(-0.357) ≈ 0.7 — the spec's 0.7 confidence cutoff applied to
// the segment's geometric-mean token probability, since Groq's Whisper
// does NOT return per-word probabilities, only per-segment ones).
//
// `start` / `end` are character offsets into the transcript `text`. We
// keep them as offsets (not word indexes) so the client can highlight by
// slicing the string without re-tokenizing — important because Whisper's
// tokenization can disagree with simple whitespace splits.
export interface JargonHint {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  text: string;
  // Empty when verbose=false, when Groq returns no segments, or when the
  // segments shape doesn't include avg_logprob (older Whisper models).
  // Callers should treat an empty array as "no hints available" — never
  // as "all words are confident."
  hints: JargonHint[];
}

// Roughly maps to the spec's "<0.7 confidence" threshold. Whisper's
// avg_logprob is a natural-log probability per segment; we mark a segment
// as low-confidence when exp(avg_logprob) < 0.7, i.e. avg_logprob <
// ln(0.7) ≈ -0.357. Tuned conservatively: the hint is a hover-only nudge
// ("Whisper wasn't sure about this word"), so a slightly-too-eager
// threshold is fine — the cost of a false positive is a useless tooltip,
// not bad copy.
const LOW_CONF_LOGPROB = Math.log(0.7);

export async function transcribeAudio(
  audio: ArrayBuffer | Blob,
  opts: TranscribeOptions,
): Promise<string> {
  const result = await transcribeAudioRich(audio, { ...opts, verbose: false });
  return result.text;
}

// Verbose transcription: returns the full text plus jargon hints derived
// from Whisper's per-segment confidence. Used by the /record voice-memo
// flow so the UI can mark mis-heard product names / jargon for the user
// to fix before generation.
//
// Important: Groq's Whisper response does NOT include a per-word
// `probability` or `confidence` field — only per-segment `avg_logprob`.
// That means hints are at segment granularity in practice: every word in
// a low-confidence segment gets flagged. We accept this tradeoff because
// (a) the alternative is shipping no hints at all, and (b) jargon
// mis-hearings usually cluster within the segment anyway (Whisper gets
// confused about a phrase, not a single phoneme). The UI tooltip copy
// reflects this: "Whisper wasn't sure about this word — tap to edit."
export async function transcribeAudioRich(
  audio: ArrayBuffer | Blob,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const apiKey = serverEnv().GROQ_API_KEY;
  if (!apiKey) throw new TranscriptionUnavailableError();

  const blob =
    audio instanceof Blob
      ? audio
      : new Blob([audio], { type: opts.contentType ?? "audio/mpeg" });

  const verbose = opts.verbose ?? true;
  const form = new FormData();
  form.append("file", blob, opts.filename);
  form.append("model", opts.model ?? DEFAULT_MODEL);
  form.append("response_format", verbose ? "verbose_json" : "json");
  if (verbose) {
    // Ask for word-level timestamps too. Even though words don't carry
    // their own confidence, the word array tells us exactly which
    // substrings live in which segments — without it we'd have to
    // re-tokenize and risk mis-aligning hints to the wrong characters.
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(
      `Groq transcription failed (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json()) as VerboseJsonResponse;
  if (typeof json.text !== "string" || json.text.length === 0) {
    throw new TranscriptionError("Groq returned an empty transcript.");
  }

  const hints = verbose ? extractJargonHints(json) : [];
  return { text: json.text, hints };
}

// ─── verbose_json shape (defensive — Groq's schema is provider-defined
//     and may shift without warning, so we narrow only what we use). ───

interface VerboseJsonSegment {
  start?: number;
  end?: number;
  avg_logprob?: number;
}
interface VerboseJsonWord {
  word?: string;
  start?: number;
  end?: number;
}
interface VerboseJsonResponse {
  text?: string;
  segments?: VerboseJsonSegment[];
  words?: VerboseJsonWord[];
}

function extractJargonHints(json: VerboseJsonResponse): JargonHint[] {
  const text = json.text ?? "";
  const segments = Array.isArray(json.segments) ? json.segments : [];
  const words = Array.isArray(json.words) ? json.words : [];
  if (segments.length === 0 || words.length === 0) return [];

  // Build a list of low-confidence time ranges. A word whose mid-point
  // falls inside one of these ranges gets flagged. Using mid-points
  // rather than `start >= seg.start && end <= seg.end` avoids edge cases
  // where Whisper's word timestamps cross a segment boundary by a few
  // milliseconds.
  const lowConfRanges: Array<{ start: number; end: number }> = [];
  for (const seg of segments) {
    if (
      typeof seg.avg_logprob !== "number" ||
      typeof seg.start !== "number" ||
      typeof seg.end !== "number"
    ) {
      continue;
    }
    if (seg.avg_logprob < LOW_CONF_LOGPROB) {
      lowConfRanges.push({ start: seg.start, end: seg.end });
    }
  }
  if (lowConfRanges.length === 0) return [];

  // Walk the words in order, mapping each flagged word to a character
  // range in `text`. We search from a moving cursor so duplicate words
  // ("the the") get distinct character spans instead of collapsing to
  // the first match.
  const hints: JargonHint[] = [];
  let cursor = 0;
  for (const w of words) {
    if (
      typeof w.word !== "string" ||
      typeof w.start !== "number" ||
      typeof w.end !== "number"
    ) {
      continue;
    }
    const wordText = w.word.trim();
    if (wordText.length === 0) continue;

    // Find this word in the transcript starting from the cursor. If we
    // can't find it (Whisper sometimes returns punctuation-stripped
    // word text vs the formatted transcript), skip — better to drop a
    // hint than to highlight the wrong characters.
    const idx = text.indexOf(wordText, cursor);
    if (idx === -1) continue;
    const charStart = idx;
    const charEnd = idx + wordText.length;
    cursor = charEnd;

    const mid = (w.start + w.end) / 2;
    const inLowConf = lowConfRanges.some((r) => mid >= r.start && mid <= r.end);
    if (inLowConf) {
      hints.push({ word: wordText, start: charStart, end: charEnd });
    }
  }
  return hints;
}

export function transcriptionConfigured(): boolean {
  try {
    return Boolean(serverEnv().GROQ_API_KEY);
  } catch {
    return false;
  }
}

// Source-fetch router. Takes whatever the user submitted (URL or pasted
// text) and returns a normalized RawSource — `kind` discriminator + a
// single plain-text blob. Downstream `extractFromText()` (extract-claude.ts)
// is purely text→structured, so all the format-specific work happens here.
//
// Routing decisions:
//
//   - mode=paste → always emits kind="transcript". The user is supplying
//     ready-to-read text; we don't try to be clever about labeling whether
//     it was originally a podcast or a meeting.
//
//   - mode=url + youtube host → emits kind="youtube" if and only if a
//     paste-transcript was also supplied (V1 limitation: we can't pull
//     captions without yt-dlp or a Groq audio path). Otherwise we return
//     an UnsupportedSourceError instructing the user to paste.
//
//   - mode=url + .pdf path → UnsupportedSourceError ("PDF coming soon").
//     See extract-pdf.ts for the rationale.
//
//   - mode=url + everything else → fetchHtmlSource() and emit kind="html".

import {
  fetchHtmlSource,
  HtmlFetchError,
  validatePublicUrl,
} from "@/lib/sources/extract-html";
import {
  detectYoutubeUrl,
  fetchYoutubeTitle,
} from "@/lib/sources/extract-youtube";
import { detectPdfUrl } from "@/lib/sources/extract-pdf";
import type { RawSource, SourceInput } from "@/lib/sources/schema";

export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSourceError";
  }
}

export class ColdSourceError extends Error {
  constructor() {
    super(
      "Source has too little text to anchor a cluster. Paste at least ~200 words, or try a different source.",
    );
    this.name = "ColdSourceError";
  }
}

const MIN_TEXT_CHARS = 200; // ~30-40 words; below this Claude has nothing.

export async function fetchSource(input: SourceInput): Promise<RawSource> {
  if (input.mode === "paste") {
    const text = input.text.trim();
    if (text.length < MIN_TEXT_CHARS) throw new ColdSourceError();
    return {
      kind: "transcript",
      text,
      title: input.title.trim() || "Pasted source",
      sourceUrl: null,
      filePath: null,
    };
  }

  // mode === "url"
  const validation = validatePublicUrl(input.url);
  if (!validation.success) {
    throw new UnsupportedSourceError(
      validation.error.issues[0]?.message ?? "Invalid URL.",
    );
  }
  const url = validation.data;

  if (detectPdfUrl(url)) {
    throw new UnsupportedSourceError(
      "PDF ingestion is coming soon — for now, copy the text out of the PDF and paste it instead.",
    );
  }

  if (detectYoutubeUrl(url)) {
    // V1: YouTube without an attached transcript is a paste-required path.
    // The /sources/new form has a "paste transcript" textarea that, when
    // filled, routes through mode=paste with the URL stored in the title
    // (so attribution is preserved). Bare YouTube URLs return this error.
    const title = (await fetchYoutubeTitle(url)) ?? "YouTube video";
    throw new UnsupportedSourceError(
      `${title} — automatic YouTube transcription isn't enabled yet. ` +
        "Paste the transcript (right-click → 'Show transcript' on the video) into the textarea instead.",
    );
  }

  let fetched: Awaited<ReturnType<typeof fetchHtmlSource>>;
  try {
    fetched = await fetchHtmlSource(url);
  } catch (err) {
    if (err instanceof HtmlFetchError) throw new UnsupportedSourceError(err.message);
    throw err;
  }
  if (fetched.text.length < MIN_TEXT_CHARS) throw new ColdSourceError();

  return {
    kind: "html",
    text: fetched.text,
    title: input.title?.trim() || fetched.title,
    sourceUrl: fetched.finalUrl,
    filePath: null,
  };
}

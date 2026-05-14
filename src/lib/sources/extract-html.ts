// HTML extractor for the Phase 2.5 source ingestion path.
//
// We deliberately roll a tiny extractor here rather than pulling in
// @mozilla/readability + linkedom. Rationale:
//
//   - Readability is excellent for news/blog articles but adds ~120kB of
//     dependencies plus a DOM shim. We already ship a strip-HTML pipeline
//     in src/app/(app)/settings/brief/actions.ts that handles marketing
//     pages reasonably well; Claude downstream picks the load-bearing
//     content out of the stripped text. The summary/quote/theme extraction
//     prompt is the real signal — the HTML extractor only has to give it
//     readable plain text.
//
//   - If we hit a class of pages where the tiny extractor produces obvious
//     garbage (heavy JS shells, image-only landing pages), the right
//     follow-up is to add the Readability dep behind a flag, not to fight
//     it here. Flag this in the final summary so the main thread can make
//     the call.
//
// SSRF guard mirrors src/app/(app)/settings/brief/actions.ts:urlSchema —
// any new public-URL fetch path in the app should grow this same check.

import { z } from "zod";

const MAX_HTML_BYTES = 600_000; // ~600kB of raw HTML; enough for a long blog
const FETCH_TIMEOUT_MS = 12_000;
const MAX_TEXT_CHARS = 40_000; // Claude reads this; cap at ~10k tokens.

const publicUrlSchema = z
  .string()
  .trim()
  .url("Enter a valid URL (https://example.com).")
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      // SSRF guard — refuse loopback / link-local / common private hostnames.
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.endsWith(".local") ||
        host.startsWith("169.254.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, "URL must be a public http(s) address.");

export function validatePublicUrl(url: string): z.SafeParseReturnType<string, string> {
  return publicUrlSchema.safeParse(url);
}

// Strip script/style/svg/comments + decode common entities + collapse
// whitespace. Mirrors stripHtml() in src/app/(app)/settings/brief/actions.ts
// — kept local rather than shared because the brief extractor is the only
// other caller and lifting it into a helper module is premature now.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-effort title extraction — look for an <h1> first, fall back to
// <title>. Both can be missing or empty (some SPAs); the caller falls back
// to the URL pathname as a last resort.
function extractTitle(html: string): string | null {
  const h1 = /<h1\b[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html);
  if (h1?.[1]) {
    const clean = stripHtml(h1[1]).trim();
    if (clean.length > 0) return clean.slice(0, 280);
  }
  const t = /<title\b[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  if (t?.[1]) {
    const clean = stripHtml(t[1]).trim();
    if (clean.length > 0) return clean.slice(0, 280);
  }
  return null;
}

export interface FetchedHtml {
  text: string;
  title: string;
  finalUrl: string;
}

export class HtmlFetchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "HtmlFetchError";
  }
}

export async function fetchHtmlSource(url: string): Promise<FetchedHtml> {
  const parsed = publicUrlSchema.safeParse(url);
  if (!parsed.success) {
    throw new HtmlFetchError(parsed.error.issues[0]?.message ?? "Invalid URL.");
  }

  let html: string;
  let finalUrl: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(parsed.data, {
      signal: controller.signal,
      headers: {
        "User-Agent": "marketingmagic-source-bot/1.0 (+https://marketingmagic.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new HtmlFetchError(`Fetch failed (${res.status}).`, res.status);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("xml") && !ct.includes("text")) {
      throw new HtmlFetchError(`Unsupported content-type: ${ct.split(";")[0]}`);
    }
    const raw = await res.text();
    html = raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw;
    finalUrl = res.url || parsed.data;
  } catch (err) {
    if (err instanceof HtmlFetchError) throw err;
    const reason = err instanceof Error ? err.message : "fetch failed";
    throw new HtmlFetchError(`Could not fetch URL: ${reason}`);
  }

  const text = stripHtml(html).slice(0, MAX_TEXT_CHARS);
  if (text.length < 200) {
    throw new HtmlFetchError(
      "Page has too little readable content. Paywall or JS-only page? Paste the text instead.",
    );
  }

  const title = extractTitle(html) ?? deriveTitleFromUrl(finalUrl);
  return { text, title, finalUrl };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last).replace(/[-_]/g, " ").slice(0, 280);
    return u.hostname;
  } catch {
    return "Untitled source";
  }
}

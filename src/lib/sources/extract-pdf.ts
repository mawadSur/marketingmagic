// PDF extractor for the Phase 2.5 source ingestion path.
//
// Uses pdf-parse v2 (PDFParse class). Node-only — fine here because
// `fetchSource()` runs in a Server Action (Node.js runtime by default).
// Text quality on multi-column / image-heavy / scanned PDFs is unreliable;
// when extraction yields <200 chars the upstream `MIN_TEXT_CHARS` gate in
// fetch.ts surfaces a friendly "paste the text instead" error so users
// aren't left staring at a blank result.

import { PDFParse } from "pdf-parse";
import { validatePublicUrl } from "@/lib/sources/extract-html";

const MAX_PDF_BYTES = 20_000_000; // 20MB — covers most articles + scientific PDFs
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 40_000; // ~10k tokens; aligns with HTML extractor cap

export interface FetchedPdf {
  text: string;
  title: string;
  finalUrl: string;
}

export class PdfFetchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PdfFetchError";
  }
}

export function detectPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export function detectPdfContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("application/pdf");
}

export async function fetchPdfSource(url: string): Promise<FetchedPdf> {
  const validation = validatePublicUrl(url);
  if (!validation.success) {
    throw new PdfFetchError(validation.error.issues[0]?.message ?? "Invalid URL.");
  }
  const target = validation.data;

  let buffer: Uint8Array;
  let finalUrl: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent": "marketingmagic-source-bot/1.0 (+https://marketingmagic.app)",
        Accept: "application/pdf",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new PdfFetchError(`Fetch failed (${res.status}).`, res.status);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!detectPdfContentType(ct) && !detectPdfUrl(res.url || target)) {
      throw new PdfFetchError(`Not a PDF (content-type: ${ct.split(";")[0] || "unknown"}).`);
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    if (raw.byteLength > MAX_PDF_BYTES) {
      throw new PdfFetchError(
        `PDF is ${Math.round(raw.byteLength / 1_000_000)}MB — over the 20MB cap.`,
      );
    }
    buffer = raw;
    finalUrl = res.url || target;
  } catch (err) {
    if (err instanceof PdfFetchError) throw err;
    const reason = err instanceof Error ? err.message : "fetch failed";
    throw new PdfFetchError(`Could not fetch PDF: ${reason}`);
  }

  let text: string;
  let pdfTitle: string | null = null;
  let parser: InstanceType<typeof PDFParse> | null = null;
  try {
    parser = new PDFParse({ data: buffer });
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);
    text = (textResult.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
    const rawTitle = infoResult?.info?.Title;
    if (rawTitle && typeof rawTitle === "string" && rawTitle.trim().length > 0) {
      pdfTitle = rawTitle.trim().slice(0, 280);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "parse failed";
    throw new PdfFetchError(`Could not parse PDF: ${reason}`);
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }

  if (text.length < 200) {
    throw new PdfFetchError(
      "PDF has too little extractable text (likely scanned or image-only). Paste the text instead.",
    );
  }

  const title = pdfTitle ?? deriveTitleFromUrl(finalUrl);
  return { text, title, finalUrl };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) {
      return decodeURIComponent(last)
        .replace(/\.pdf$/i, "")
        .replace(/[-_]/g, " ")
        .slice(0, 280);
    }
    return u.hostname;
  } catch {
    return "Untitled PDF";
  }
}

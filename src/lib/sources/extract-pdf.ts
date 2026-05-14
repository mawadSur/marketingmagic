// PDF extractor.
//
// V1: we do NOT parse PDF bytes in-app. pdf-parse pulls a 4MB dependency
// + a Node-only PDF.js runtime that's awkward on Vercel's edge, and the
// quality on multi-column / image-heavy academic PDFs is unreliable.
// Better: tell users to copy-paste the readable text into the paste
// textarea — Claude will pick the load-bearing themes/quotes out of the
// pasted content.
//
// The /sources/new UI surfaces a "PDF coming soon — paste the text instead"
// helper when a user types a `.pdf` URL into the URL field. The /sources
// page docs the workflow.
//
// When we're ready to ship real PDF support, the entry point is here:
//   - flag adding `pdf-parse` + `pdfjs-dist` as deps
//   - implement extractPdfText(buf: ArrayBuffer): Promise<{ title, text }>
//   - route from fetch.ts when a URL ends in `.pdf` or content-type is PDF.

export function detectPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return path.endsWith(".pdf");
  } catch {
    return false;
  }
}

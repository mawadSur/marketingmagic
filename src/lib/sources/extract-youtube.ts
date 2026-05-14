// YouTube transcript extractor.
//
// V1 scope (intentional):
//
//   - We do NOT download audio from YouTube. Doing it properly needs yt-dlp
//     (a Python binary) which doesn't ship to Vercel's runtime, and the
//     youtube-dl-exec npm wrappers all need ffmpeg + the binary side-loaded.
//     Building a transcoder pipeline is its own multi-day project — see
//     Phase 3 "Transcoding target" decision in tasks.md.
//
//   - We DO accept a YouTube URL + paste-of-transcript. The /sources/new
//     form has a textarea for "paste the transcript" alongside the URL
//     field. When the textarea is filled we just package the pasted text
//     as the source body and attribute it to the YouTube URL.
//
//   - When GROQ_API_KEY is set AND we can pull audio (future), we will
//     route through groq.audio.transcriptions.create() with the whisper
//     model. That code lives in src/lib/sources/transcribe.ts as a
//     placeholder helper so we can wire it up later without renaming the
//     module from a UI page reference.
//
// This file's surface is intentionally small — `detectYoutubeUrl()` so the
// router can identify YouTube links, and `buildYoutubeSourceFromPaste()`
// which is a glorified passthrough but keeps the call site uniform.

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function detectYoutubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Best-effort YouTube title scrape. We hit the oEmbed endpoint, which
// returns JSON with the title and uploader — works for public videos
// without an API key, and gracefully fails (returning null) for private/
// age-gated content.
export async function fetchYoutubeTitle(url: string): Promise<string | null> {
  if (!detectYoutubeUrl(url)) return null;
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(oembed, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { title?: string };
    if (typeof json.title === "string" && json.title.length > 0) {
      return json.title.slice(0, 280);
    }
    return null;
  } catch {
    return null;
  }
}

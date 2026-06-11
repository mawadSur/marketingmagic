"use client";

import { useEffect, useRef, useState } from "react";
import { Play, X } from "lucide-react";

// Homepage "how it works" explainer. Renders a poster with a play button; the
// click opens an accessible lightbox that plays the video. The video SOURCE is
// optional on purpose — until a real clip exists we show a tasteful "coming
// soon" poster, and the moment a URL is supplied (mp4 in /public, or a YouTube/
// Loom embed) it plays with no other change. Performance: nothing heavy loads
// until the user opens the lightbox (the <video>/<iframe> mounts on open), so
// the page stays light. Reduced-motion safe (no autoplay, no looping motion).
export function ExplainerVideo({
  // Self-hosted file in /public (preferred — full control, captions). e.g. "/explainer.mp4".
  src,
  // OR an embeddable URL (YouTube/Loom) if you'd rather host it there.
  embedUrl,
  // Poster shown before play. Falls back to a branded placeholder if unset.
  poster,
  // Optional captions track for the self-hosted path (accessibility).
  captionsSrc,
  title = "How marketingmagic works",
}: {
  src?: string;
  embedUrl?: string;
  poster?: string;
  captionsSrc?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasVideo = Boolean(src || embedUrl);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Lightbox a11y: lock scroll, close on Esc, focus the close button on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {/* Poster / trigger. 16:9 box reserves space so there's no layout shift. */}
      <div className="relative mx-auto aspect-video w-full max-w-3xl overflow-hidden rounded-2xl border bg-card shadow-lg">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          // Branded placeholder when no poster yet — gradient + subtle grid.
          <div aria-hidden className="brand-gradient absolute inset-0 opacity-90" />
        )}
        {/* Darkening scrim so the play button + label read on any poster. */}
        <div aria-hidden className="absolute inset-0 bg-black/30" />

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
          {hasVideo ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="group inline-flex flex-col items-center gap-3 rounded-2xl p-4 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
              aria-label={`Play video: ${title}`}
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/95 text-foreground shadow-xl transition-transform duration-200 group-hover:scale-105">
                <Play className="ml-0.5 h-7 w-7 fill-current" aria-hidden />
              </span>
              <span className="text-sm font-medium drop-shadow">Watch the 90-second tour</span>
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-white">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/20 backdrop-blur">
                <Play className="ml-0.5 h-6 w-6 fill-current" aria-hidden />
              </span>
              <p className="text-sm font-medium drop-shadow">Product tour — coming soon</p>
              <p className="max-w-xs text-xs text-white/85 drop-shadow">
                A 90-second walkthrough of plan → approve → improve.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox — mounted only when open, so the media loads on demand. */}
      {open && hasVideo ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4"
          onClick={(e) => {
            // Click on the backdrop (not the player) closes.
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="relative w-full max-w-4xl">
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close video"
              className="absolute -top-10 right-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="h-4 w-4" aria-hidden />
              Close
            </button>
            <div className="aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl">
              {src ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={src}
                  poster={poster}
                  controls
                  autoPlay
                  playsInline
                  className="h-full w-full"
                >
                  {captionsSrc ? (
                    <track kind="captions" src={captionsSrc} srcLang="en" label="English" default />
                  ) : null}
                </video>
              ) : embedUrl ? (
                <iframe
                  src={embedUrl}
                  title={title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full border-0"
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

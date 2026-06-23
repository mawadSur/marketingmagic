// Coming-soon teaser shown at /video/upload while USER_VIDEO_UPLOAD_ENABLED is
// off. Keeps the feature DISCOVERABLE (the Upload tab links here) without
// exposing the live uploader — a deliberate "coming soon" state rather than a
// 404. No backend dependency: pure server-rendered marketing.

import Link from "next/link";
import { Upload, Captions, Scissors, Megaphone, ArrowRight } from "lucide-react";

const STEPS = [
  {
    icon: Upload,
    title: "Upload your own footage",
    body: "A talk, a screen recording, a podcast clip — long videos are fine, they go straight to secure storage.",
  },
  {
    icon: Captions,
    title: "Auto-transcribe + captions",
    body: "We transcribe it on the way in. Edit the text, export SRT/VTT, or burn captions right onto the clip.",
  },
  {
    icon: Scissors,
    title: "Cut the moments that matter",
    body: "Mark up the highlights on a timeline and we cut caption-ready clips — one upload becomes a week of posts.",
  },
  {
    icon: Megaphone,
    title: "Market it everywhere",
    body: "Send each clip into the same approve-and-go queue as your posts, on-voice captions per channel.",
  },
] as const;

export function UploadComingSoon() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
          Coming soon
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Upload a video</h1>
        <p className="text-sm text-muted-foreground">
          Bring your own footage and turn it into a week of short-form clips —
          transcribed, cut, captioned, and ready to post across your channels.
          We&apos;re putting the finishing touches on it; it&apos;ll open up right
          here the moment it&apos;s ready.
        </p>
      </header>

      <ol className="grid gap-3 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className="rounded-xl border bg-card p-4 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <s.icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                Step {i + 1}
              </span>
            </div>
            <h2 className="mt-3 text-sm font-semibold">{s.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="rounded-xl border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">
          In the meantime, you can already generate short-form video from a
          topic.
        </p>
        <Link
          href="/video"
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
        >
          Generate a video from a topic
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

import Link from "next/link";

// Switcher between the video generation modes so each is discoverable from the
// others: the MPT "from a topic" path (/video), the UGC "saved avatar + script"
// path (/video?mode=ugc, Higgsfield), the fal.ai "animate a photo" path
// (/settings/reference-video), and the "upload your own video → cut clips" path
// (/video/upload). The UGC + reference tabs only appear when
// REFERENCE_VIDEO_ENABLED is on. The Upload tab is ALWAYS shown so the feature
// is discoverable — when USER_VIDEO_UPLOAD_ENABLED is off it wears a "Soon"
// badge and lands on a coming-soon teaser instead of the live uploader.
type VideoMode = "topic" | "ugc" | "reference" | "upload";

export function VideoModeTabs({
  active,
  referenceEnabled,
  uploadEnabled = false,
}: {
  active: VideoMode;
  referenceEnabled: boolean;
  uploadEnabled?: boolean;
}) {
  const tabs: Array<{ key: VideoMode; label: string; href: string; soon?: boolean }> = [
    { key: "topic", label: "From a topic", href: "/video" },
    // Always discoverable; "Soon" until the flag flips.
    { key: "upload", label: "Upload a video", href: "/video/upload", soon: !uploadEnabled },
    ...(referenceEnabled
      ? [
          { key: "ugc" as const, label: "UGC avatar", href: "/video?mode=ugc" },
          { key: "reference" as const, label: "Animate a photo", href: "/settings/reference-video" },
        ]
      : []),
  ];

  return (
    <div className="inline-flex rounded-lg border bg-muted/30 p-1 text-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={
            active === t.key
              ? "inline-flex items-center gap-1.5 rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              : "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {t.label}
          {t.soon ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Soon
            </span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

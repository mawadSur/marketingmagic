import Link from "next/link";

// Switcher between the video generation modes so each is discoverable from the
// others: the MPT "from a topic" path (/video), the UGC "saved avatar + script"
// path (/video?mode=ugc, Higgsfield), and the fal.ai "animate a photo" path
// (/settings/reference-video). The UGC + reference tabs only appear when
// REFERENCE_VIDEO_ENABLED is on — so when the feature is off this collapses to
// nothing on /video and never points anywhere dead.
type VideoMode = "topic" | "ugc" | "reference";

export function VideoModeTabs({
  active,
  referenceEnabled,
}: {
  active: VideoMode;
  referenceEnabled: boolean;
}) {
  const tabs: Array<{ key: VideoMode; label: string; href: string }> = [
    { key: "topic", label: "From a topic", href: "/video" },
    ...(referenceEnabled
      ? [
          { key: "ugc" as const, label: "UGC avatar", href: "/video?mode=ugc" },
          { key: "reference" as const, label: "Animate a photo", href: "/settings/reference-video" },
        ]
      : []),
  ];
  // Nothing to switch to — hide the control entirely.
  if (tabs.length < 2) return null;

  return (
    <div className="inline-flex rounded-lg border bg-muted/30 p-1 text-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={
            active === t.key
              ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              : "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

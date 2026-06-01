import Link from "next/link";

// Switcher between the two video generation modes so each is discoverable from
// the other: the MPT "from a topic" path (/video) and the fal.ai "animate a
// photo" path (/settings/reference-video). The reference tab only appears when
// REFERENCE_VIDEO_ENABLED is on — so when the feature is off this collapses to
// nothing on /video and never points anywhere dead.
export function VideoModeTabs({
  active,
  referenceEnabled,
}: {
  active: "topic" | "reference";
  referenceEnabled: boolean;
}) {
  const tabs: Array<{ key: "topic" | "reference"; label: string; href: string }> = [
    { key: "topic", label: "From a topic", href: "/video" },
    ...(referenceEnabled
      ? [{ key: "reference" as const, label: "Animate a photo", href: "/settings/reference-video" }]
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

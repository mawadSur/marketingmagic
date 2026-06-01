import Link from "next/link";

// Small pill links to related sibling pages. Used to keep routes reachable
// after they were pulled out of the top nav (e.g. Goals/Sources from Plans,
// Competitors/Portfolio from Analytics).
export function SectionLinks({
  links,
}: {
  links: { href: string; label: string }[];
}) {
  if (links.length === 0) return null;
  return (
    <nav className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">Also</span>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-full border px-3 py-1 text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

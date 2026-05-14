import Link from "next/link";
import { Badge } from "@/components/ui/badge";

// Small badge surfaced on queue / dashboard rows to indicate "this post
// came from source X." Clicking takes the user to /sources/[id] so they
// can see the originating material.
//
// Designed to slot into the existing meta-line on QueueRow (channel
// pill + timestamp + theme + best-time badge). Kept minimal — no icon,
// no extended hover — because the row already has plenty of decoration.
export function SourceAttributionBadge({
  sourceId,
  title,
}: {
  sourceId: string;
  title?: string | null;
}) {
  return (
    <Link
      href={`/sources/${sourceId}`}
      className="inline-flex items-center"
      title={title ? `From source: ${title}` : "Generated from a source"}
    >
      <Badge variant="muted" className="hover:bg-muted/60 cursor-pointer">
        from source
      </Badge>
    </Link>
  );
}

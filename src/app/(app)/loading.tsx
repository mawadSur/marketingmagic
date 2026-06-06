import { Skeleton } from "@/components/ui/skeleton";

// Pending UI for the authed shell. The (app) layout already wraps the children
// slot in `.container py-8`, so this renders inside that padded area — a few
// stacked bars instead of a blank white screen while a slow page resolves.
export default function AppLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
    </div>
  );
}

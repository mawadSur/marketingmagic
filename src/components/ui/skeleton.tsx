import { cn } from "@/lib/utils";

/**
 * Skeleton — neutral pulsing placeholder for loading states.
 *
 * Usage: <Skeleton className="h-4 w-32" /> inside a Suspense fallback or
 * pending UI. Uses tailwindcss-animate's `animate-pulse` (no extra deps).
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted/70", className)}
      {...props}
    />
  );
}

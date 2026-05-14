import { Button } from "@/components/ui/button";

// Server component — no client state needed. It's a plain anchor that hits
// our /install endpoint, which kicks the OAuth dance. Keeps the worktree
// from carrying a useless "use client" boundary just to render a button.

export function DiscordInstallButton({
  label = "Install Discord bot",
  href = "/api/integrations/discord/install",
}: {
  label?: string;
  href?: string;
}) {
  return (
    <Button asChild>
      <a href={href}>{label}</a>
    </Button>
  );
}

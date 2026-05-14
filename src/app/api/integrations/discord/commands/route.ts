import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { registerGlobalCommands, type SlashCommand } from "@/lib/integrations/discord";

// One-shot slash-command registration. Idempotent: Discord's PUT overwrite
// replaces the entire global command set, so re-calling this is safe.
//
// Auth: same Bearer-CRON_SECRET pattern as the other cron routes. We don't
// run this on every deploy — operators call it once after editing the
// command shape below. Global commands take up to an hour to propagate to
// every Discord client, which is fine for our cadence (rarely changes).
//
// Slash command shape:
//   /mm queue   → ephemeral count of pending approvals
//   /mm stats   → ephemeral today's KPIs
//   /mm pause   → toggle trust-mode auto-posting workspace-wide
//
// Discord modelling: a single root `/mm` with three sub-commands (option
// type 1) keeps the namespace clean. Users see `/mm queue` in autocomplete.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMMANDS: SlashCommand[] = [
  {
    name: "mm",
    description: "marketingmagic — approvals, stats, posting controls",
    options: [
      { name: "queue", description: "Show pending approval count", type: 1 },
      { name: "stats", description: "Show today's KPIs", type: 1 },
      { name: "pause", description: "Toggle trust-mode auto-posting", type: 1 },
    ],
  },
];

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CLIENT_ID) {
    return NextResponse.json(
      { skipped: "DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID not set" },
      { status: 200 },
    );
  }

  try {
    await registerGlobalCommands(COMMANDS);
    return NextResponse.json({ ok: true, registered: COMMANDS.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "register_failed" },
      { status: 500 },
    );
  }
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

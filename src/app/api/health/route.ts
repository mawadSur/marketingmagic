import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { serverEnv } from "@/lib/env";

// Health check endpoint for uptime monitors. Returns 200 when the app is healthy,
// 503 when a critical dependency is down. No auth required (monitors need a public
// endpoint) but leak nothing sensitive — just ok/error status.
//
// Checks:
//   1. Supabase connectivity — trivial select to confirm the DB is reachable.
//   2. Critical env vars — ANTHROPIC_API_KEY, CRON_SECRET (bare existence check,
//      not API validation; we don't want to burn quota / rate-limit on every probe).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // 1. Supabase connectivity. A trivial select — we don't care about the result,
    //    just that the query completes without throwing. This catches: DB unreachable,
    //    service-role key invalid, connection-string misconfigured.
    const svc = supabaseService();
    const { error: dbErr } = await svc.from("brand_briefs").select("id").limit(1).maybeSingle();
    if (dbErr) {
      return NextResponse.json(
        { ok: false, error: "database_unreachable" },
        { status: 503 },
      );
    }

    // 2. Critical env vars. Bare existence check — we don't validate that the key
    //    is well-formed or works (that would burn quota / rate-limit on every probe).
    //    We just confirm the var is set so the app can start.
    const env = serverEnv();
    if (!env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "missing_anthropic_key" },
        { status: 503 },
      );
    }
    if (!env.CRON_SECRET) {
      return NextResponse.json(
        { ok: false, error: "missing_cron_secret" },
        { status: 503 },
      );
    }

    // All checks passed.
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Catch-all for unexpected errors (e.g., env validation threw, supabase client
    // construction failed). Return 503 so the monitor knows the app is unhealthy.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 503 },
    );
  }
}

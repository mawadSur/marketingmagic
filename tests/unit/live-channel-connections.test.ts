import { describe, it, expect, beforeAll } from "vitest";

// ── LIVE smoke: are the stored channel connections actually alive? ───────────
//
// Unlike the rest of tests/unit/** (which mock every network call), THIS suite
// hits the REAL provider APIs using the credentials currently stored in
// social_accounts. It answers the question the manual Chrome sessions kept
// re-asking: "is my X / IG / Threads / … connection still working, or did the
// token expire / get revoked?"
//
// It is OPT-IN and never runs in CI or a normal `npm test`:
//   LIVE_CHANNEL_CHECK=1 npm run test:channels:live
// Without LIVE_CHANNEL_CHECK the whole suite is skipped (so it's safe to leave
// in the default vitest include glob).
//
// For each connected account it calls that channel's verify():
//   - x / tiktok      → loadFresh*Credentials first (refreshes + persists an
//                        expired token), then verify. This is the SAME refresh
//                        path the cron uses, so a green result means a scheduled
//                        post a day later would also authenticate.
//   - ig / threads / fb / linkedin / bluesky → verify directly (their tokens are
//                        long-lived; verify surfaces revocation/expiry).
//
// The suite prints a green/red board (mirroring scripts/prod-smoke.mjs) and
// fails if ANY connected account is dead — so it's a real go/no-go signal.

const LIVE = process.env.LIVE_CHANNEL_CHECK === "1" || process.env.LIVE_CHANNEL_CHECK === "true";

// Load .env.local / .env only when we actually intend to hit live APIs, so the
// default (mocked) unit run never depends on real secrets being present.
if (LIVE) {
  const { config } = await import("dotenv");
  config({ path: ".env.local", override: false });
  config({ path: ".env", override: false });
}

interface AccountRow {
  id: string;
  workspace_id: string;
  channel: string;
  handle: string;
  status: string;
  credentials: Record<string, unknown>;
}

interface LiveResult {
  channel: string;
  handle: string;
  ok: boolean;
  detail: string;
}

// Verify a single account against its live provider. Returns a friendly label
// on success; throws on a dead connection (caught by the caller into a report).
async function verifyAccount(
  account: AccountRow,
  svc: import("@supabase/supabase-js").SupabaseClient,
): Promise<string> {
  const creds = account.credentials as Record<string, unknown>;
  switch (account.channel) {
    case "x": {
      const { xVerify, loadFreshXCredentials } = await import("@/lib/social/x");
      const fresh = await loadFreshXCredentials(svc, account.id, creds as never);
      const v = await xVerify(fresh as never);
      return `@${v.username} (id ${v.id})`;
    }
    case "tiktok": {
      const { tiktokVerify, loadFreshTikTokCredentials } = await import("@/lib/social/tiktok");
      const fresh = await loadFreshTikTokCredentials(svc, account.id, creds as never);
      const v = await tiktokVerify(fresh);
      return `${v.handle} (open_id ${v.openId})`;
    }
    case "instagram": {
      const { instagramVerify } = await import("@/lib/social/instagram");
      const v = await instagramVerify(String(creds.accessToken), String(creds.igUserId));
      return `@${v.username}`;
    }
    case "threads": {
      const { threadsVerify } = await import("@/lib/social/threads");
      const v = await threadsVerify(String(creds.accessToken), String(creds.userId));
      return `@${v.username}`;
    }
    case "facebook": {
      const { facebookVerify } = await import("@/lib/social/facebook");
      const v = await facebookVerify(String(creds.pageId), String(creds.pageAccessToken));
      return `Page "${v.name}"`;
    }
    case "linkedin": {
      const { linkedinVerify } = await import("@/lib/social/linkedin");
      const v = await linkedinVerify(String(creds.accessToken));
      return `${v.name} (${v.urn})`;
    }
    case "bluesky": {
      const { blueskyVerify } = await import("@/lib/social/bluesky");
      const v = await blueskyVerify(creds as never);
      return `${v.handle} (${v.did})`;
    }
    default:
      throw new Error(`No live verifier for channel "${account.channel}"`);
  }
}

describe.skipIf(!LIVE)("LIVE channel connection smoke (opt-in: LIVE_CHANNEL_CHECK=1)", () => {
  let accounts: AccountRow[] = [];
  const results: LiveResult[] = [];

  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "LIVE_CHANNEL_CHECK needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY " +
          "(loaded from .env.local). Run via `npm run test:channels:live`.",
      );
    }
    const { createClient } = await import("@supabase/supabase-js");
    const svc = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Only connected accounts are worth checking — 'disconnected'/'revoked'
    // rows linger for post-history FK reasons but carry wiped/dead credentials.
    const { data, error } = await svc
      .from("social_accounts")
      .select("id, workspace_id, channel, handle, status, credentials")
      .eq("status", "connected");
    if (error) throw new Error(`Failed to read social_accounts: ${error.message}`);
    accounts = (data ?? []) as AccountRow[];

    // Run every account's live verify, collecting a result instead of throwing
    // so the board shows the full picture (one dead channel doesn't hide others).
    for (const account of accounts) {
      try {
        const detail = await verifyAccount(account, svc);
        results.push({ channel: account.channel, handle: account.handle, ok: true, detail });
      } catch (err) {
        results.push({
          channel: account.channel,
          handle: account.handle,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Print the green/red board.
    const lines = results.map(
      (r) => `  ${r.ok ? "✅" : "❌"} ${r.channel.padEnd(10)} @${r.handle} — ${r.detail}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n── LIVE channel connections (${results.filter((r) => r.ok).length}/${results.length} alive) ──\n` +
        (lines.length ? lines.join("\n") : "  (no connected accounts found)") +
        "\n",
    );
  });

  it("found at least one connected account to check", () => {
    expect(
      accounts.length,
      "No connected social_accounts found. Connect a channel first, or check the DB.",
    ).toBeGreaterThan(0);
  });

  it("every connected account's live credentials still authenticate", () => {
    const dead = results.filter((r) => !r.ok);
    expect(
      dead,
      `Dead connections:\n${dead.map((d) => `  ${d.channel} @${d.handle}: ${d.detail}`).join("\n")}`,
    ).toEqual([]);
  });
});
